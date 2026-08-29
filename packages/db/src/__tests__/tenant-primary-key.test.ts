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

describe('tenant composite primary keys', () => {
  test('requires a logical identity even though tenant scope supplies the other PK column', async () => {
    const alpha = tracked.withTenant('alpha')

    const cause = await databaseCause(
      alpha.into(schema.tenant_records).insert({ value: 'missing logical identity' }),
    )
    expect(cause.message).toMatch(/null value in column "id"/)
    expect(await alpha.from(schema.tenant_records).all()).toEqual([])
  })

  test('isolates reads, updates, and deletes when two tenants reuse one logical ID', async () => {
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')

    await alpha.into(schema.tenant_records).insert({ id: 'shared', value: 'alpha' })
    await beta.into(schema.tenant_records).insert({ id: 'shared', value: 'beta' })

    expect(await alpha.from(schema.tenant_records).where(eq('id', 'shared')).first()).toMatchObject(
      {
        workspaceId: 'alpha',
        value: 'alpha',
      },
    )
    expect(await beta.from(schema.tenant_records).where(eq('id', 'shared')).first()).toMatchObject({
      workspaceId: 'beta',
      value: 'beta',
    })

    await alpha
      .from(schema.tenant_records)
      .where(eq('id', 'shared'))
      .update({ value: 'alpha updated' })
    expect((await beta.from(schema.tenant_records).where(eq('id', 'shared')).first())?.value).toBe(
      'beta',
    )

    await alpha.from(schema.tenant_records).where(eq('id', 'shared')).delete()
    expect(await alpha.from(schema.tenant_records).all()).toEqual([])
    expect((await beta.from(schema.tenant_records).all()).map((row) => row.value)).toEqual(['beta'])
  })

  test('resolves tenant-local foreign keys against the matching tenant only', async () => {
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')

    await alpha.into(schema.tenant_parents).insert({ id: 'parent', name: 'alpha parent' })
    await alpha
      .into(schema.tenant_children)
      .insert({ id: 'child', parentId: 'parent', name: 'alpha child' })

    const cause = await databaseCause(
      beta
        .into(schema.tenant_children)
        .insert({ id: 'child', parentId: 'parent', name: 'beta child' }),
    )
    expect(cause.message).toMatch(/foreign key constraint/)

    await beta.into(schema.tenant_parents).insert({ id: 'parent', name: 'beta parent' })
    await beta
      .into(schema.tenant_children)
      .insert({ id: 'child', parentId: 'parent', name: 'beta child' })

    expect((await alpha.from(schema.tenant_children).all()).map((row) => row.name)).toEqual([
      'alpha child',
    ])
    expect((await beta.from(schema.tenant_children).all()).map((row) => row.name)).toEqual([
      'beta child',
    ])
  })

  test('keeps draft row identity tenant-qualified while using the logical scalar key', async () => {
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')
    await alpha.into(schema.tenant_records).insert({ id: 'shared', value: 'alpha canonical' })
    await beta.into(schema.tenant_records).insert({ id: 'shared', value: 'beta canonical' })

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

    expect((await alpha.withDraft('shared-draft').from(schema.tenant_records).first())?.value).toBe(
      'alpha draft',
    )
    expect((await beta.withDraft('shared-draft').from(schema.tenant_records).first())?.value).toBe(
      'beta draft',
    )
  })
})
