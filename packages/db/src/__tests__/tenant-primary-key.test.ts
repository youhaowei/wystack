import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { createDrizzleTracker, defineSchema, eq, multiTenant, syncSchema, text } from '../index'

const tenancy = multiTenant({
  key: { property: 'workspaceId', column: 'workspace_id', type: text },
})

const schema = defineSchema({
  tenant_records: tenancy.table({ id: text.primaryKey(), value: text }).draftable(),
  tenant_parents: tenancy.table({ id: text.primaryKey(), name: text }),
  tenant_children: tenancy.table({
    id: text.primaryKey(),
    parentId: text.referencesWithinTenant('tenant_parents'),
    name: text,
  }),
})

let client: PGlite | undefined
let tracked: ReturnType<typeof createDrizzleTracker>

async function databaseCause(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    if (error instanceof Error) {
      const cause = (error as Error & { cause?: unknown }).cause
      return cause instanceof Error ? cause : error
    }
    throw error
  }
  throw new Error('Expected the database operation to fail')
}

beforeEach(async () => {
  client = new PGlite()
  await client.waitReady
  const db = drizzle(client)
  await syncSchema(db, schema)
  tracked = createDrizzleTracker(db)
})

afterEach(async () => {
  await client?.close()
  client = undefined
})

async function seedTwoTenantsWithSharedLogicalId() {
  const alpha = tracked.withTenant('alpha')
  const beta = tracked.withTenant('beta')
  await alpha.into(schema.tenant_records).insert({ id: 'shared', value: 'alpha canonical' })
  await beta.into(schema.tenant_records).insert({ id: 'shared', value: 'beta canonical' })
  return { alpha, beta }
}

describe('tenant-qualified row identity', () => {
  test('requires a logical identity even though tenant scope supplies the other PK column', async () => {
    const alpha = tracked.withTenant('alpha')

    const cause = await databaseCause(
      alpha.into(schema.tenant_records).insert({ value: 'missing logical identity' }),
    )
    expect(cause.message).toMatch(/null value in column "id"/)
  })

  test('allows two tenants to store the same logical identity', async () => {
    const { alpha, beta } = await seedTwoTenantsWithSharedLogicalId()

    expect({
      alpha: await alpha.from(schema.tenant_records).where(eq('id', 'shared')).first(),
      beta: await beta.from(schema.tenant_records).where(eq('id', 'shared')).first(),
    }).toMatchObject({
      alpha: { workspaceId: 'alpha', value: 'alpha canonical' },
      beta: { workspaceId: 'beta', value: 'beta canonical' },
    })
  })

  test('updates only the tenant-qualified row when logical identities overlap', async () => {
    const { alpha, beta } = await seedTwoTenantsWithSharedLogicalId()

    await alpha
      .from(schema.tenant_records)
      .where(eq('id', 'shared'))
      .update({ value: 'alpha updated' })

    expect({
      alpha: (await alpha.from(schema.tenant_records).where(eq('id', 'shared')).first())?.value,
      beta: (await beta.from(schema.tenant_records).where(eq('id', 'shared')).first())?.value,
    }).toEqual({ alpha: 'alpha updated', beta: 'beta canonical' })
  })

  test('deletes only the tenant-qualified row when logical identities overlap', async () => {
    const { alpha, beta } = await seedTwoTenantsWithSharedLogicalId()

    await alpha.from(schema.tenant_records).where(eq('id', 'shared')).delete()

    expect({
      alpha: await alpha.from(schema.tenant_records).where(eq('id', 'shared')).first(),
      beta: (await beta.from(schema.tenant_records).where(eq('id', 'shared')).first())?.value,
    }).toEqual({ alpha: null, beta: 'beta canonical' })
  })

  test('resolves tenant-local foreign keys against the matching tenant only', async () => {
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')

    await alpha.into(schema.tenant_parents).insert({ id: 'parent', name: 'alpha parent' })

    const cause = await databaseCause(
      beta
        .into(schema.tenant_children)
        .insert({ id: 'child', parentId: 'parent', name: 'beta child' }),
    )
    expect(cause.message).toMatch(/foreign key constraint/)

    await beta.into(schema.tenant_parents).insert({ id: 'parent', name: 'beta parent' })
    const inserted = await beta
      .into(schema.tenant_children)
      .insert({ id: 'child', parentId: 'parent', name: 'beta child' })

    expect(inserted).toMatchObject([
      { workspaceId: 'beta', parentId: 'parent', name: 'beta child' },
    ])
  })

  test('keeps draft row identity tenant-qualified while using the logical scalar key', async () => {
    const { alpha, beta } = await seedTwoTenantsWithSharedLogicalId()

    await alpha
      .withDraft('shared-draft')
      .from(schema.tenant_records)
      .where(eq('id', 'shared'))
      .update({ value: 'alpha draft' })
    await beta
      .withDraft('shared-draft')
      .from(schema.tenant_records)
      .where(eq('id', 'shared'))
      .update({ value: 'beta draft' })

    expect({
      alpha: (await alpha.withDraft('shared-draft').from(schema.tenant_records).first())?.value,
      beta: (await beta.withDraft('shared-draft').from(schema.tenant_records).first())?.value,
    }).toEqual({ alpha: 'alpha draft', beta: 'beta draft' })
  })
})
