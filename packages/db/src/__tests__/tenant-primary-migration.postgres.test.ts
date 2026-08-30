import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { defineSchema, migrateTenantPrimaryKeys, multiTenant, syncSchema, text } from '../index'

const postgresUrl = process.env['WYSTACK_TEST_POSTGRES_URL']
const describeWithPostgres = postgresUrl ? describe : describe.skip
const tenancy = multiTenant({
  key: { property: 'workspaceId', column: 'workspace_id', type: text },
})
const schema = defineSchema({
  upgraded_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
})

describeWithPostgres('tenant-primary migration — real PostgreSQL', () => {
  const namespace = `wystack_tenant_primary_${process.pid}_${Date.now()}`
  let admin: ReturnType<typeof postgres>
  let client: ReturnType<typeof postgres>

  beforeAll(async () => {
    admin = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`)
    client = postgres(postgresUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: namespace },
    })
    await client.unsafe(`
      CREATE TABLE upgraded_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        CONSTRAINT upgraded_accounts_workspace_id_id_unique UNIQUE (workspace_id, id)
      )
    `)
  })

  afterAll(async () => {
    await client?.end({ timeout: 1 })
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`)
      await admin.end({ timeout: 1 })
    }
  })

  test('upgrades the supported legacy shape atomically and permits tenant ID reuse', async () => {
    const db = drizzle(client)
    await syncSchema(db, schema)
    await client.unsafe(
      `INSERT INTO upgraded_accounts (workspace_id, id, name) VALUES ('alpha', 'shared', 'alpha')`,
    )

    expect(await migrateTenantPrimaryKeys(db, schema)).toEqual({
      migrated: ['upgraded_accounts'],
      alreadyCurrent: [],
    })
    await client.unsafe(
      `INSERT INTO upgraded_accounts (workspace_id, id, name) VALUES ('beta', 'shared', 'beta')`,
    )

    const [identity] = await client<{ columns: string; rows: number }[]>`
      SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality) AS columns,
             (SELECT count(*)::integer FROM upgraded_accounts) AS rows
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN LATERAL unnest(constraint_record.conkey)
        WITH ORDINALITY AS key_column(attribute_number, ordinality) ON TRUE
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum = key_column.attribute_number
      WHERE constraint_record.contype = 'p'
        AND relation.relname = 'upgraded_accounts'
      GROUP BY relation.relname
    `
    expect(identity).toEqual({ columns: 'workspace_id,id', rows: 2 })
  })
})
