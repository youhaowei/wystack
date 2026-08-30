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
const failClosedSchema = defineSchema({
  a_real_legacy_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
  z_real_current_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
  zz_real_index_legacy_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
})
const expressionSchema = defineSchema({
  a_real_expression_legacy_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
  z_real_expression_current_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
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
      );
      CREATE TABLE a_real_legacy_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        CONSTRAINT a_real_legacy_accounts_workspace_id_id_unique UNIQUE (workspace_id, id)
      );
      CREATE TABLE z_real_current_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        CONSTRAINT z_real_current_accounts_pkey PRIMARY KEY (workspace_id, id),
        CONSTRAINT z_real_current_accounts_id_unique UNIQUE (id)
      );
      CREATE TABLE z_real_current_children (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        CONSTRAINT z_real_current_children_parent_fk
          FOREIGN KEY (parent_id) REFERENCES z_real_current_accounts (id)
      );
      CREATE TABLE zz_real_index_legacy_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        CONSTRAINT zz_real_index_legacy_accounts_workspace_id_id_unique
          UNIQUE (workspace_id, id)
      );
      CREATE UNIQUE INDEX zz_real_index_legacy_accounts_id_unique_idx
        ON zz_real_index_legacy_accounts (id) INCLUDE (name)
        WHERE name <> 'excluded';
      CREATE TABLE a_real_expression_legacy_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        CONSTRAINT a_real_expression_legacy_accounts_workspace_id_id_unique
          UNIQUE (workspace_id, id)
      );
      CREATE TABLE z_real_expression_current_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        CONSTRAINT z_real_expression_current_accounts_pkey PRIMARY KEY (workspace_id, id)
      );
      CREATE UNIQUE INDEX a_real_expression_legacy_name_unique_idx
        ON a_real_expression_legacy_accounts ((lower(name))) INCLUDE (id);
      CREATE UNIQUE INDEX z_real_expression_current_name_partial_idx
        ON z_real_expression_current_accounts ((lower(name)))
        WHERE name <> 'excluded';
      CREATE UNIQUE INDEX z_real_expression_current_tenant_id_idx
        ON z_real_expression_current_accounts (workspace_id, ((id || '')));
      CREATE UNIQUE INDEX z_real_expression_current_id_idx
        ON z_real_expression_current_accounts (((id || ''))) INCLUDE (id);
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

  test('fails closed on expression-derived global identity without rejecting safe controls', async () => {
    const db = drizzle(client)
    await client.unsafe(`
      INSERT INTO a_real_expression_legacy_accounts
        VALUES ('alpha', 'shared', 'legacy alpha');
      INSERT INTO z_real_expression_current_accounts
        VALUES ('alpha', 'shared', 'current alpha');
    `)

    await expect(migrateTenantPrimaryKeys(db, expressionSchema)).rejects.toThrow(
      /index "z_real_expression_current_id_idx".*\(workspace_id\) is a direct key attribute/,
    )

    const [legacyIdentityBeforeCleanup] = await client<{ columns: string }[]>`
      SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality) AS columns
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN LATERAL unnest(constraint_record.conkey)
        WITH ORDINALITY AS key_column(attribute_number, ordinality) ON TRUE
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum = key_column.attribute_number
      WHERE constraint_record.contype = 'p'
        AND relation.relname = 'a_real_expression_legacy_accounts'
      GROUP BY relation.relname
    `
    expect(legacyIdentityBeforeCleanup).toEqual({ columns: 'id' })

    await client.unsafe(`
      DROP INDEX z_real_expression_current_id_idx;
      CREATE UNIQUE INDEX a_real_expression_legacy_id_partial_idx
        ON a_real_expression_legacy_accounts (((id || ''))) INCLUDE (name)
        WHERE name <> 'excluded';
    `)
    await expect(migrateTenantPrimaryKeys(db, expressionSchema)).rejects.toThrow(
      /index "a_real_expression_legacy_id_partial_idx".*\(workspace_id\) is a direct key attribute/,
    )

    await client.unsafe(`DROP INDEX a_real_expression_legacy_id_partial_idx`)
    expect(await migrateTenantPrimaryKeys(db, expressionSchema)).toEqual({
      migrated: ['a_real_expression_legacy_accounts'],
      alreadyCurrent: ['z_real_expression_current_accounts'],
    })
    await client.unsafe(`
      INSERT INTO a_real_expression_legacy_accounts
        VALUES ('beta', 'shared', 'legacy beta');
      INSERT INTO z_real_expression_current_accounts
        VALUES ('beta', 'shared', 'current beta');
    `)
    expect(await migrateTenantPrimaryKeys(db, expressionSchema)).toEqual({
      migrated: [],
      alreadyCurrent: ['a_real_expression_legacy_accounts', 'z_real_expression_current_accounts'],
    })
    const [rows] = await client<{ legacy: number; current: number }[]>`
      SELECT (SELECT count(*)::integer FROM a_real_expression_legacy_accounts) AS legacy,
             (SELECT count(*)::integer FROM z_real_expression_current_accounts) AS current
    `
    expect(rows).toEqual({ legacy: 2, current: 2 })
  })

  test('fails closed on global identity remnants before legacy or current acceptance', async () => {
    const db = drizzle(client)
    await client.unsafe(`
      INSERT INTO a_real_legacy_accounts VALUES ('alpha', 'shared', 'legacy alpha');
      INSERT INTO z_real_current_accounts VALUES ('alpha', 'shared', 'current alpha');
      INSERT INTO z_real_current_children VALUES ('beta', 'beta child', 'shared');
      INSERT INTO zz_real_index_legacy_accounts VALUES ('alpha', 'shared', 'index alpha');
    `)

    await expect(migrateTenantPrimaryKeys(db, failClosedSchema)).rejects.toThrow(
      /z_real_current_children\.z_real_current_children_parent_fk.*include "workspace_id"/,
    )

    await client.unsafe(`
      ALTER TABLE z_real_current_children
        DROP CONSTRAINT z_real_current_children_parent_fk
    `)
    await expect(migrateTenantPrimaryKeys(db, failClosedSchema)).rejects.toThrow(
      /constraint "z_real_current_accounts_id_unique".*\(workspace_id\) is a direct key attribute/,
    )

    await client.unsafe(`
      ALTER TABLE z_real_current_accounts
        DROP CONSTRAINT z_real_current_accounts_id_unique
    `)
    await expect(migrateTenantPrimaryKeys(db, failClosedSchema)).rejects.toThrow(
      /index "zz_real_index_legacy_accounts_id_unique_idx".*\(workspace_id\) is a direct key attribute/,
    )

    const legacyIdentitiesBeforeCleanup = await client<{ table_name: string; columns: string }[]>`
      SELECT relation.relname AS table_name,
             string_agg(attribute.attname, ',' ORDER BY key_column.ordinality) AS columns
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN LATERAL unnest(constraint_record.conkey)
        WITH ORDINALITY AS key_column(attribute_number, ordinality) ON TRUE
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum = key_column.attribute_number
      WHERE constraint_record.contype = 'p'
        AND relation.relname IN ('a_real_legacy_accounts', 'zz_real_index_legacy_accounts')
      GROUP BY relation.relname
      ORDER BY relation.relname
    `
    expect([...legacyIdentitiesBeforeCleanup]).toEqual([
      { table_name: 'a_real_legacy_accounts', columns: 'id' },
      { table_name: 'zz_real_index_legacy_accounts', columns: 'id' },
    ])

    await client.unsafe(`
      DROP INDEX zz_real_index_legacy_accounts_id_unique_idx
    `)
    expect(await migrateTenantPrimaryKeys(db, failClosedSchema)).toEqual({
      migrated: ['a_real_legacy_accounts', 'zz_real_index_legacy_accounts'],
      alreadyCurrent: ['z_real_current_accounts'],
    })

    await client.unsafe(`
      INSERT INTO a_real_legacy_accounts VALUES ('beta', 'shared', 'legacy beta');
      INSERT INTO z_real_current_accounts VALUES ('beta', 'shared', 'current beta');
      INSERT INTO zz_real_index_legacy_accounts VALUES ('beta', 'shared', 'index beta');
    `)
    const [rows] = await client<{ legacy: number; current: number; indexed: number }[]>`
      SELECT (SELECT count(*)::integer FROM a_real_legacy_accounts) AS legacy,
             (SELECT count(*)::integer FROM z_real_current_accounts) AS current,
             (SELECT count(*)::integer FROM zz_real_index_legacy_accounts) AS indexed
    `
    expect(rows).toEqual({ legacy: 2, current: 2, indexed: 2 })
  })
})
