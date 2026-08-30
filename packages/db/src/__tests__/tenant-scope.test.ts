import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import {
  createDrizzleTracker,
  defineSchema,
  eq,
  int,
  multiTenant,
  syncSchema,
  table,
  text,
  timestamp,
} from '../index'
import { uuid } from '../dsl'
import { enumerateDraftRowChanges } from '../drizzle-tracker'

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
  archivedInsights: tenancy
    .table({
      id: uuid.primaryKey(),
      name: text,
      deletedAt: timestamp.nullable(),
      revision: int,
    })
    .softDelete('deletedAt')
    .revision('revision')
    .draftable(),
})

const uuidTenantSchema = defineSchema({
  uuid_insights: multiTenant().table({ id: uuid.primaryKey(), name: text }).draftable(),
})

const intTenantSchema = defineSchema({
  int_insights: multiTenant({
    key: { property: 'tenantId', column: 'tenant_id', type: int },
  })
    .table({ id: uuid.primaryKey(), name: text })
    .draftable(),
})

let tracked: ReturnType<typeof createDrizzleTracker>
let client: PGlite | undefined

beforeEach(async () => {
  client = new PGlite()
  await client.waitReady
  const db = drizzle(client)
  await syncSchema(db, schema)
  await syncSchema(db, uuidTenantSchema)
  await syncSchema(db, intTenantSchema)
  tracked = createDrizzleTracker(db)
})

afterEach(async () => {
  await client?.close()
  client = undefined
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
        // @ts-expect-error — the runtime guard still protects untyped callers
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
    // @ts-expect-error — the runtime guard still protects untyped callers
    await expect(alpha.from(schema.insights).update({ workspaceId: 'beta' })).rejects.toThrow(
      'system-managed',
    )
  })

  test('soft deletion is tenant-bound, hidden by default, restorable, and revisioned', async () => {
    const sharedId = '00000000-0000-4000-8000-000000000055'
    const removedAt = new Date('2026-08-29T12:00:00.000Z')
    const alpha = createDrizzleTracker(tracked.raw).withTenant('alpha')
    const beta = createDrizzleTracker(tracked.raw).withTenant('beta')
    await alpha.into(schema.archivedInsights).insert({ id: sharedId, name: 'alpha' })
    await beta.into(schema.archivedInsights).insert({ id: sharedId, name: 'beta' })
    const alphaDeletion = createDrizzleTracker(tracked.raw).withTenant('alpha')

    await expect(
      alphaDeletion.from(schema.archivedInsights).where(eq('id', sharedId)).delete(),
    ).rejects.toThrow('physical delete() is unavailable')
    const deleted = await alphaDeletion
      .from(schema.archivedInsights)
      .where(eq('id', sharedId))
      .softDelete(removedAt)

    expect(deleted).toMatchObject([{ name: 'alpha', revision: 2, deletedAt: removedAt }])
    expect(await alpha.from(schema.archivedInsights).all()).toEqual([])
    expect(await alpha.from(schema.archivedInsights).onlyDeleted().all()).toMatchObject([
      { name: 'alpha', revision: 2, deletedAt: removedAt },
    ])
    expect(await alpha.from(schema.archivedInsights).includeDeleted().all()).toHaveLength(1)
    expect(await beta.from(schema.archivedInsights).all()).toMatchObject([
      { name: 'beta', revision: 1, deletedAt: null },
    ])
    expect([...alphaDeletion.tablesWritten]).toEqual(['tenant:alpha:archivedInsights'])

    const restored = await alpha.from(schema.archivedInsights).where(eq('id', sharedId)).restore()
    expect(restored).toMatchObject([{ name: 'alpha', revision: 3, deletedAt: null }])
    expect(await alpha.from(schema.archivedInsights).all()).toHaveLength(1)
  })

  test('canonical restore ignores active rows after includeDeleted()', async () => {
    const activeId = '00000000-0000-4000-8000-000000000091'
    const deletedId = '00000000-0000-4000-8000-000000000092'
    const removedAt = new Date('2026-08-29T12:30:00.000Z')
    const alpha = tracked.withTenant('alpha')
    await alpha.into(schema.archivedInsights).insert({ id: activeId, name: 'active' })
    await alpha.into(schema.archivedInsights).insert({ id: deletedId, name: 'deleted' })
    await alpha.from(schema.archivedInsights).where(eq('id', deletedId)).softDelete(removedAt)

    const restored = await alpha.from(schema.archivedInsights).includeDeleted().restore()

    expect(restored).toMatchObject([
      { id: deletedId, name: 'deleted', revision: 3, deletedAt: null },
    ])
    expect(
      await alpha.from(schema.archivedInsights).includeDeleted().where(eq('id', activeId)).first(),
    ).toMatchObject({ id: activeId, name: 'active', revision: 1, deletedAt: null })
  })

  test('rejects invalid tombstone timestamps in canonical and draft writes', async () => {
    const id = '00000000-0000-4000-8000-000000000057'
    const alpha = tracked.withTenant('alpha')
    await alpha.into(schema.archivedInsights).insert({ id, name: 'active' })
    const invalidDate = new Date(Number.NaN)

    await expect(
      alpha.from(schema.archivedInsights).where(eq('id', id)).softDelete(invalidDate),
    ).rejects.toThrow('requires a valid explicit Date')
    await expect(
      alpha
        .withDraft('invalid-timestamp')
        .from(schema.archivedInsights)
        .where(eq('id', id))
        .softDelete(invalidDate),
    ).rejects.toThrow('requires a valid explicit Date')
  })

  test('rejects untyped tombstone fields on canonical and draft inserts and updates', async () => {
    const canonicalId = '00000000-0000-4000-8000-000000000058'
    const draftId = '00000000-0000-4000-8000-000000000059'
    const alpha = tracked.withTenant('alpha')
    const draft = alpha.withDraft('forged-tombstones')

    await expect(
      alpha.into(schema.archivedInsights).insert({
        id: canonicalId,
        name: 'forged canonical insert',
        // @ts-expect-error — runtime custody must also reject untyped callers
        deletedAt: new Date(),
      }),
    ).rejects.toThrow('use softDelete(at) or restore()')
    await alpha.into(schema.archivedInsights).insert({ id: canonicalId, name: 'canonical active' })
    await expect(
      alpha.from(schema.archivedInsights).where(eq('id', canonicalId)).update({
        // @ts-expect-error — runtime custody must also reject untyped callers
        deletedAt: new Date(),
      }),
    ).rejects.toThrow('use softDelete(at) or restore()')

    await expect(
      draft.into(schema.archivedInsights).insert({
        id: draftId,
        name: 'forged draft insert',
        // @ts-expect-error — runtime custody must also reject untyped callers
        deletedAt: new Date(),
      }),
    ).rejects.toThrow('use softDelete(at) or restore()')
    await expect(
      draft.from(schema.archivedInsights).where(eq('id', canonicalId)).update({
        // @ts-expect-error — runtime custody must also reject untyped callers
        deletedAt: null,
      }),
    ).rejects.toThrow('use softDelete(at) or restore()')
  })

  test('draft soft deletion changes only the effective view and can be restored', async () => {
    const id = '00000000-0000-4000-8000-000000000056'
    const removedAt = new Date('2026-08-29T13:00:00.000Z')
    const alpha = tracked.withTenant('alpha')
    await alpha.into(schema.archivedInsights).insert({ id, name: 'drafted' })
    const draft = alpha.withDraft('soft-delete-draft')

    await expect(draft.from(schema.archivedInsights).where(eq('id', id)).delete()).rejects.toThrow(
      'physical delete() is unavailable',
    )
    await draft.from(schema.archivedInsights).where(eq('id', id)).softDelete(removedAt)

    expect(await alpha.from(schema.archivedInsights).where(eq('id', id)).first()).toMatchObject({
      revision: 1,
      deletedAt: null,
    })
    expect(await draft.from(schema.archivedInsights).where(eq('id', id)).first()).toBeNull()
    expect(
      await draft.from(schema.archivedInsights).onlyDeleted().where(eq('id', id)).first(),
    ).toMatchObject({ revision: 2, deletedAt: removedAt })

    await draft.from(schema.archivedInsights).where(eq('id', id)).restore()
    expect(await draft.from(schema.archivedInsights).where(eq('id', id)).first()).toMatchObject({
      revision: 3,
      deletedAt: null,
    })
  })

  test('draft restore ignores active rows after includeDeleted()', async () => {
    const activeId = '00000000-0000-4000-8000-000000000093'
    const deletedId = '00000000-0000-4000-8000-000000000094'
    const removedAt = new Date('2026-08-29T13:30:00.000Z')
    const alpha = tracked.withTenant('alpha')
    await alpha.into(schema.archivedInsights).insert({ id: activeId, name: 'active' })
    await alpha.into(schema.archivedInsights).insert({ id: deletedId, name: 'deleted' })
    await alpha.from(schema.archivedInsights).where(eq('id', deletedId)).softDelete(removedAt)
    const draft = alpha.withDraft('restore-only-deleted')

    const restored = await draft.from(schema.archivedInsights).includeDeleted().restore()

    expect(restored).toMatchObject([
      { id: deletedId, name: 'deleted', revision: 3, deletedAt: null },
    ])
    expect(
      await draft.from(schema.archivedInsights).includeDeleted().where(eq('id', activeId)).first(),
    ).toMatchObject({ id: activeId, name: 'active', revision: 1, deletedAt: null })
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

  test('tenant drafts may read global tables but cannot write their derived state', async () => {
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

  test('UUID tenant tags use the canonical database identity across accepted spellings', async () => {
    const upperTenant = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const lowerTenant = upperTenant.toLowerCase()
    const reader = createDrizzleTracker(tracked.raw).withTenant(
      `{${upperTenant.replaceAll('-', '')}}`,
    )
    const writer = createDrizzleTracker(tracked.raw).withTenant(lowerTenant)

    await reader.withDraft('uuid-draft').from(uuidTenantSchema.uuid_insights).all()
    await writer.withDraft('uuid-draft').into(uuidTenantSchema.uuid_insights).insert({
      id: '00000000-0000-4000-8000-000000000091',
      name: 'same tenant',
    })

    expect([...reader.tablesRead].some((tag) => writer.tablesWritten.has(tag))).toBe(true)
    expect(await reader.withDraft('uuid-draft').from(uuidTenantSchema.uuid_insights).all()).toEqual(
      [
        {
          id: '00000000-0000-4000-8000-000000000091',
          name: 'same tenant',
          tenantId: lowerTenant,
        },
      ],
    )
    expect((await enumerateDraftRowChanges(tracked.raw, 'uuid-draft'))[0]?.tenantKey).toEqual({
      type: 'uuid',
      value: lowerTenant,
    })
  })

  test('integer tenant tags use the canonical database identity across accepted spellings', async () => {
    const reader = createDrizzleTracker(tracked.raw).withTenant('01')
    const writer = createDrizzleTracker(tracked.raw).withTenant(1)

    await reader.withDraft('int-draft').from(intTenantSchema.int_insights).all()
    await writer.withDraft('int-draft').into(intTenantSchema.int_insights).insert({
      id: '00000000-0000-4000-8000-000000000092',
      name: 'same tenant',
    })

    expect([...reader.tablesRead].some((tag) => writer.tablesWritten.has(tag))).toBe(true)
    expect(await reader.withDraft('int-draft').from(intTenantSchema.int_insights).all()).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000092',
        name: 'same tenant',
        tenantId: 1,
      },
    ])
    expect((await enumerateDraftRowChanges(tracked.raw, 'int-draft'))[0]?.tenantKey).toEqual({
      type: 'integer',
      value: 1,
    })
  })

  test('tenant identity validation rejects spellings PostgreSQL would reject', async () => {
    for (const invalidInteger of ['', '0x10', '2147483648', '-2147483649', '\u00a01\u00a0']) {
      await expect(
        createDrizzleTracker(tracked.raw)
          .withTenant(invalidInteger)
          .from(intTenantSchema.int_insights)
          .all(),
      ).rejects.toThrow('Invalid integer identity')
    }

    await expect(
      createDrizzleTracker(tracked.raw)
        .withTenant('a-aaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa')
        .from(uuidTenantSchema.uuid_insights)
        .all(),
    ).rejects.toThrow('Invalid UUID identity')

    await expect(
      createDrizzleTracker(tracked.raw)
        .withTenant(' aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa ')
        .from(uuidTenantSchema.uuid_insights)
        .all(),
    ).rejects.toThrow('Invalid UUID identity')
  })
})
