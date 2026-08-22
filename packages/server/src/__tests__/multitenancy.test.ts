import { beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, multiTenant, syncSchema, table, text, uuid } from '@wystack/db'
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
const wy = defineApp<Record<string, unknown>>({ permissions: {} })

let app: Awaited<ReturnType<typeof wy.build>>

beforeEach(async () => {
  const client = new PGlite()
  await client.waitReady
  const db = drizzle(client)
  await syncSchema(db, schema)
  app = await wy.build({
    db,
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

  test('plain tables remain usable without tenant resolution', async () => {
    const appWithoutResolver = await wy.build({
      db: app.createTracked().raw,
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
      'access denied',
    )
    await expect(restartedProcess.getLog(draftId, { context: bob })).rejects.toThrow(
      'access denied',
    )
    expect(await restartedProcess.getLog(draftId, { context: alice })).toHaveLength(1)

    await restartedProcess.publish(draftId, undefined, { context: alice })
    const alphaRows = (await app.call('listInsights', {}, alpha)).result as { name: string }[]
    const betaRows = (await app.call('listInsights', {}, beta)).result as { name: string }[]
    expect(alphaRows.map((row) => row.name)).toEqual(['drafted'])
    expect(betaRows).toEqual([])
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
    ).rejects.toThrow('access denied')
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
