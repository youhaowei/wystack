import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, int, multiTenant, syncSchema, table, text, uuid } from '@wystack/db'
import { applyCommands } from '../apply-commands'
import { createDraftLifecycle } from '../draft-lifecycle'
import { defineApp } from '../define-app'

const tenancy = multiTenant({
  key: { property: 'workspaceId', column: 'workspace_id', type: text },
})
const schema = defineSchema({
  catalog: table({ id: uuid.primaryKey(), name: text }),
  insights: tenancy.table({ id: uuid.primaryKey(), name: text }).draftable(),
})
const intTenancy = multiTenant({
  key: { property: 'tenantId', column: 'tenant_id', type: int },
})
const intSchema = defineSchema({
  integerInsights: intTenancy.table({ id: uuid.primaryKey(), name: text }).draftable(),
})
const wy = defineApp<Record<string, unknown>>({ permissions: {} })

let app: Awaited<ReturnType<typeof wy.build>>
let client: PGlite
let db: ReturnType<typeof drizzle>

beforeEach(async () => {
  client = new PGlite()
  await client.waitReady
  db = drizzle(client)
  await syncSchema(db, schema)
  await syncSchema(db, intSchema)
  app = await wy.build({
    db,
    tenancy,
    resolveTenant: async (context) => {
      const requested = context.requestedTenantId
      const allowed = context.allowedTenantIds
      if (
        typeof requested !== 'string' ||
        !Array.isArray(allowed) ||
        !allowed.includes(requested)
      ) {
        throw new Error('tenant access denied')
      }
      return requested
    },
    functions: {
      addInsight: wy.procedure
        .input({ id: uuid, name: text })
        .mutation(async (ctx, args) => ctx.db.into(schema.insights).insert(args)),
      listInsights: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.insights).all()),
      addCatalog: wy.procedure
        .input({ id: uuid, name: text })
        .mutation(async (ctx, args) => ctx.db.into(schema.catalog).insert(args)),
    },
  })
})

afterEach(async () => {
  await client.close()
})

const alpha = { requestedTenantId: 'alpha', allowedTenantIds: ['alpha'] }
const beta = { requestedTenantId: 'beta', allowedTenantIds: ['beta'] }

describe('server tenant resolution', () => {
  test('requested tenant selection is resolved before tenant-table access', async () => {
    await app.call(
      'addInsight',
      { id: '00000000-0000-4000-8000-000000000001', name: 'alpha' },
      alpha,
    )
    await app.call('addInsight', { id: '00000000-0000-4000-8000-000000000002', name: 'beta' }, beta)

    const alphaRows = (await app.call('listInsights', {}, alpha)).result as { name: string }[]
    const betaRows = (await app.call('listInsights', {}, beta)).result as { name: string }[]
    expect(alphaRows.map((row) => row.name)).toEqual(['alpha'])
    expect(betaRows.map((row) => row.name)).toEqual(['beta'])
  })

  test('a requested tenant ID does not grant access', async () => {
    await expect(
      app.call('listInsights', {}, { requestedTenantId: 'beta', allowedTenantIds: ['alpha'] }),
    ).rejects.toThrow('tenant access denied')
  })

  test('command batches inherit one resolved tenant scope', async () => {
    await applyCommands(
      app,
      [
        {
          path: 'addInsight',
          args: { id: '00000000-0000-4000-8000-000000000003', name: 'batched' },
        },
      ],
      { mode: 'commit', context: alpha },
    )

    const rows = (await app.call('listInsights', {}, alpha)).result as { name: string }[]
    expect(rows.map((row) => row.name)).toEqual(['batched'])
  })

  test('public outer-transaction batches still resolve tenant scope from context', async () => {
    const outer = app.system.createTracked()
    await outer.transaction((tx) =>
      applyCommands(
        app,
        [
          {
            path: 'addInsight',
            args: { id: '00000000-0000-4000-8000-000000000008', name: 'outer-alpha' },
          },
        ],
        { mode: 'commit', context: alpha, tx },
      ),
    )

    const alphaRows = (await app.call('listInsights', {}, alpha)).result as { name: string }[]
    const betaRows = (await app.call('listInsights', {}, beta)).result as { name: string }[]
    expect(alphaRows.map((row) => row.name)).toEqual(['outer-alpha'])
    expect(betaRows).toEqual([])
  })

  test('plain tables remain usable without tenant resolution', async () => {
    const appWithoutResolver = await wy.build({
      db: app.system.createTracked().raw,
      functions: {
        addCatalog: wy.procedure
          .input({ id: uuid, name: text })
          .mutation(async (ctx, args) => ctx.db.into(schema.catalog).insert(args)),
      },
    })
    const result = await appWithoutResolver.call('addCatalog', {
      id: '00000000-0000-4000-8000-000000000004',
      name: 'global',
    })
    expect(result.result).toHaveLength(1)
  })

  test('read and write invalidation tags are tenant-scoped', async () => {
    const alphaRead = await app.call('listInsights', {}, alpha)
    const betaWrite = await app.call(
      'addInsight',
      { id: '00000000-0000-4000-8000-000000000005', name: 'beta' },
      beta,
    )
    const alphaWrite = await app.call(
      'addInsight',
      { id: '00000000-0000-4000-8000-000000000006', name: 'alpha' },
      alpha,
    )

    expect([...alphaRead.tablesRead].some((tag) => betaWrite.tablesWritten.has(tag))).toBe(false)
    expect([...alphaRead.tablesRead].some((tag) => alphaWrite.tablesWritten.has(tag))).toBe(true)
  })

  test('durable drafts retain tenant and owner custody across lifecycle recreation', async () => {
    const resolveOwner = (context: Record<string, unknown>) => context.principalId
    const alice = { ...alpha, principalId: 'alice' }
    const bob = { ...alpha, principalId: 'bob' }
    const firstProcess = createDraftLifecycle(app, { resolveOwner })
    const draftId = await firstProcess.open(0, { context: alice })
    await firstProcess.append(
      draftId,
      [
        {
          path: 'addInsight',
          args: { id: '00000000-0000-4000-8000-000000000007', name: 'drafted' },
        },
      ],
      { context: alice },
    )

    const restartedProcess = createDraftLifecycle(app, { resolveOwner })
    await expect(restartedProcess.getLog(draftId, { context: beta })).rejects.toThrow(
      'unknown draft',
    )
    await expect(restartedProcess.getLog(draftId, { context: bob })).rejects.toThrow(
      'unknown draft',
    )
    expect(await restartedProcess.getLog(draftId, { context: alice })).toHaveLength(1)
    expect(await restartedProcess.inspect(draftId, { context: alice })).toMatchObject([
      {
        table: 'insights',
        operation: 'insert',
        tenantKey: { type: 'text', value: 'alpha' },
        rowKey: { type: 'uuid', value: '00000000-0000-4000-8000-000000000007' },
      },
    ])
    await expect(restartedProcess.inspect(draftId, { context: beta })).rejects.toThrow(
      'unknown draft',
    )

    await restartedProcess.publish(draftId, undefined, { context: alice })
    const alphaRows = (await app.call('listInsights', {}, alpha)).result as { name: string }[]
    const betaRows = (await app.call('listInsights', {}, beta)).result as { name: string }[]
    expect(alphaRows.map((row) => row.name)).toEqual(['drafted'])
    expect(betaRows).toEqual([])
  })

  /** Opening under integer spelling `01` and continuing under `1` addresses the same tenant-owned draft. */
  test('durable draft custody compares the tenant column canonical identity', async () => {
    const integerApp = await wy.build({
      db,
      tenancy: intTenancy,
      resolveTenant: (context) => context.requestedTenantId,
      functions: {
        addInsight: wy.procedure
          .input({ id: uuid, name: text })
          .mutation(async (ctx, args) => ctx.db.into(intSchema.integerInsights).insert(args)),
      },
    })
    const lifecycle = createDraftLifecycle(integerApp)
    const principal = { kind: 'user' as const, userId: 'same-owner' }
    const opened = { requestedTenantId: '01', principal }
    const canonical = { requestedTenantId: 1, principal }
    const draftId = await lifecycle.open(0, { context: opened })

    await lifecycle.append(
      draftId,
      [
        {
          path: 'addInsight',
          args: { id: '00000000-0000-4000-8000-000000000099', name: 'canonical tenant' },
        },
      ],
      { context: canonical },
    )

    expect(await lifecycle.getLog(draftId, { context: canonical })).toHaveLength(1)
    await lifecycle.publish(draftId, undefined, { context: canonical })
    expect(
      await integerApp.system.createTracked().withTenant(1).from(intSchema.integerInsights).all(),
    ).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000099',
        name: 'canonical tenant',
        tenantId: 1,
      },
    ])
  })

  test('draft collaboration requires an explicit hook and never bypasses tenant scope', async () => {
    const owner = { ...alpha, principalId: 'alice' }
    const lifecycle = createDraftLifecycle(app, {
      resolveOwner: (context) => context.principalId,
    })
    const draftId = await lifecycle.open(0, { context: owner })

    const collaborative = createDraftLifecycle(app, {
      resolveOwner: (context) => context.principalId,
      authorizeDraft: ({ context }) => context.collaborator === true,
    })
    expect(await collaborative.getLog(draftId, { context: owner })).toEqual([])
    await expect(
      collaborative.getLog(draftId, {
        context: { ...beta, collaborator: true },
      }),
    ).rejects.toThrow('unknown draft')
    expect(
      await collaborative.getLog(draftId, {
        context: { ...alpha, principalId: 'bob', collaborator: true },
      }),
    ).toEqual([])
    await collaborative.discard(draftId, {
      context: { ...alpha, principalId: 'bob', collaborator: true },
    })
  })
})
