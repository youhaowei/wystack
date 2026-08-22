import { beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import {
  createDrizzleTracker,
  defineSchema,
  eq,
  multiTenant,
  syncSchema,
  table,
  text,
} from '../index'
import { uuid } from '../dsl'

const tenancy = multiTenant({
  key: {
    property: 'workspaceId',
    column: 'workspace_id',
    type: text,
  },
})

const schema = defineSchema({
  catalog: table({ id: uuid.primaryKey(), name: text }).draftable(),
  insights: tenancy.table({ id: uuid.primaryKey(), name: text }).draftable(),
})

let tracked: ReturnType<typeof createDrizzleTracker>

beforeEach(async () => {
  const client = new PGlite()
  await client.waitReady
  const db = drizzle(client)
  await syncSchema(db, schema)
  tracked = createDrizzleTracker(db)
})

describe('tenant-scoped database access', () => {
  test('tenant tables fail closed without scope while plain tables remain unscoped', async () => {
    await tracked.into(schema.catalog).insert({
      id: '00000000-0000-4000-8000-000000000001',
      name: 'global',
    })

    await expect(tracked.from(schema.insights).all()).rejects.toThrow('tenant scope')
    await expect(
      tracked.into(schema.insights).insert({
        id: '00000000-0000-4000-8000-000000000002',
        name: 'unscoped',
      }),
    ).rejects.toThrow('tenant scope')
    expect(await tracked.from(schema.catalog).all()).toHaveLength(1)
  })

  test('inserts inject trusted scope and reads cannot cross tenants', async () => {
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')

    const [alphaRow] = await alpha.into(schema.insights).insert({
      id: '00000000-0000-4000-8000-000000000010',
      name: 'alpha insight',
    })
    await beta.into(schema.insights).insert({
      id: '00000000-0000-4000-8000-000000000020',
      name: 'beta insight',
    })

    expect(alphaRow.workspaceId).toBe('alpha')
    expect(await alpha.from(schema.insights).all()).toEqual([alphaRow])
    expect((await beta.from(schema.insights).all()).map((row) => row.name)).toEqual([
      'beta insight',
    ])
  })

  test('caller-supplied tenant values never replace resolved scope', async () => {
    const alpha = tracked.withTenant('alpha')
    await expect(
      alpha.into(schema.insights).insert({
        id: '00000000-0000-4000-8000-000000000030',
        name: 'forged',
        workspaceId: 'beta',
      }),
    ).rejects.toThrow('system-managed')
  })

  test('updates, deletes, and transactions retain tenant scope', async () => {
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')
    await alpha.into(schema.insights).insert({
      id: '00000000-0000-4000-8000-000000000040',
      name: 'alpha',
    })
    await beta.into(schema.insights).insert({
      id: '00000000-0000-4000-8000-000000000050',
      name: 'beta',
    })

    await alpha.transaction(async (tx) => {
      const updated = await tx
        .from(schema.insights)
        .where(eq('name', 'alpha'))
        .update({ name: 'alpha updated' })
      expect(updated).toHaveLength(1)
    })

    expect(await beta.from(schema.insights).where(eq('name', 'alpha updated')).all()).toEqual([])
    expect(
      await alpha.from(schema.insights).where(eq('name', 'alpha updated')).delete(),
    ).toHaveLength(1)
    expect(await alpha.from(schema.insights).all()).toEqual([])
    expect(await beta.from(schema.insights).all()).toHaveLength(1)
  })

  test('tenant property cannot be updated', async () => {
    const alpha = tracked.withTenant('alpha')
    await expect(alpha.from(schema.insights).update({ workspaceId: 'beta' })).rejects.toThrow(
      'system-managed',
    )
  })

  test('tenant and draft scopes compose across reads and writes', async () => {
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')
    await alpha.into(schema.insights).insert({
      id: '00000000-0000-4000-8000-000000000060',
      name: 'alpha canonical',
    })
    await beta.into(schema.insights).insert({
      id: '00000000-0000-4000-8000-000000000070',
      name: 'beta canonical',
    })

    const alphaDraft = alpha.withDraft('shared-draft-id')
    const betaDraft = beta.withDraft('shared-draft-id')
    await alphaDraft.from(schema.insights).where(eq('name', 'alpha canonical')).update({
      name: 'alpha draft',
    })
    await betaDraft.into(schema.insights).insert({
      id: '00000000-0000-4000-8000-000000000080',
      name: 'beta draft insert',
    })

    expect((await alphaDraft.from(schema.insights).all()).map((row) => row['name'])).toEqual([
      'alpha draft',
    ])
    expect((await betaDraft.from(schema.insights).all()).map((row) => row['name'])).toEqual([
      'beta canonical',
      'beta draft insert',
    ])
  })

  test('tenant drafts may read global tables but cannot write their shadows', async () => {
    await tracked.into(schema.catalog).insert({
      id: '00000000-0000-4000-8000-000000000061',
      name: 'global catalog',
    })
    const tenantDraft = tracked.withTenant('alpha').withDraft('alpha-draft')
    await tracked
      .withDraft('alpha-draft')
      .from(schema.catalog)
      .where(eq('name', 'global catalog'))
      .update({ name: 'privileged global draft' })

    expect(await tenantDraft.from(schema.catalog).all()).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000061',
        name: 'global catalog',
      },
    ])
    await expect(
      tenantDraft.into(schema.catalog).insert({
        id: '00000000-0000-4000-8000-000000000062',
        name: 'forbidden',
      }),
    ).rejects.toThrow('cannot write global table')
    await expect(
      tenantDraft.from(schema.catalog).where(eq('name', 'global catalog')).update({
        name: 'forbidden',
      }),
    ).rejects.toThrow('cannot write global table')
    await expect(
      tenantDraft.from(schema.catalog).where(eq('name', 'global catalog')).delete(),
    ).rejects.toThrow('cannot write global table')
  })

  test('tenant draft tags do not overlap across tenants', async () => {
    const alphaTracker = createDrizzleTracker(tracked.raw).withTenant('alpha')
    const betaTracker = createDrizzleTracker(tracked.raw).withTenant('beta')
    await alphaTracker.withDraft('d1').from(schema.insights).all()
    await betaTracker.withDraft('d1').into(schema.insights).insert({
      id: '00000000-0000-4000-8000-000000000090',
      name: 'beta',
    })

    expect([...alphaTracker.tablesRead].some((tag) => betaTracker.tablesWritten.has(tag))).toBe(
      false,
    )
  })
})
