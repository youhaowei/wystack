import { afterEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { pgTable, text as pgText, unique } from 'drizzle-orm/pg-core'
import {
  adoptSchema,
  createDrizzleTracker,
  defineSchema,
  migrateTenantPrimaryKeys,
  multiTenant,
  syncSchema,
  text,
} from '../index'

const tenancy = multiTenant({
  key: { property: 'workspaceId', column: 'workspace_id', type: text },
})

const schema = defineSchema({
  migration_parents: tenancy.table({ id: text.primaryKey(), name: text }),
  migration_children: tenancy.table({
    id: text.primaryKey(),
    parentId: text.referencesWithinTenant('migration_parents'),
    name: text,
  }),
})

const unsafeSchema = defineSchema({
  unsafe_migration_parents: tenancy.table({ id: text.primaryKey(), name: text }),
})

const currentDependencySchema = defineSchema({
  current_dependency_parents: tenancy.table({ id: text.primaryKey(), name: text }),
})

const atomicShapeSchema = defineSchema({
  a_atomic_legacy_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
  z_atomic_current_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
})

const openDatabases = new Set<PGlite>()

function createTestDatabase(): PGlite {
  const client = new PGlite()
  openDatabases.add(client)
  return client
}

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

afterEach(async () => {
  const databases = [...openDatabases]
  openDatabases.clear()
  await Promise.all(databases.map((client) => client.close()))
})

describe('migrateTenantPrimaryKeys', () => {
  test('contracts bootstrapped tenant tables without breaking tenant-local foreign keys', async () => {
    const client = createTestDatabase()
    await client.waitReady
    await client.exec(`
      CREATE TABLE migration_parents (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        CONSTRAINT migration_parents_workspace_id_id_unique UNIQUE (workspace_id, id)
      );
      CREATE TABLE migration_children (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        "parentId" TEXT NOT NULL,
        name TEXT NOT NULL,
        CONSTRAINT migration_children_workspace_id_id_unique UNIQUE (workspace_id, id),
        CONSTRAINT migration_children_parent_fk
          FOREIGN KEY (workspace_id, "parentId")
          REFERENCES migration_parents (workspace_id, id)
      );
      INSERT INTO migration_parents VALUES ('alpha', 'shared-parent', 'alpha parent');
      INSERT INTO migration_children VALUES ('alpha', 'shared-child', 'shared-parent', 'alpha child');
    `)
    const db = drizzle(client)

    // The supported sequence creates missing tables but does not pretend that
    // CREATE TABLE IF NOT EXISTS upgraded an existing physical identity.
    await syncSchema(db, schema)
    await expect(
      client.exec(`INSERT INTO migration_parents VALUES ('beta', 'shared-parent', 'beta blocked')`),
    ).rejects.toThrow(/unique|duplicate/i)

    expect(await migrateTenantPrimaryKeys(db, schema)).toEqual({
      migrated: ['migration_children', 'migration_parents'],
      alreadyCurrent: [],
    })

    const tracked = createDrizzleTracker(db)
    const beta = tracked.withTenant('beta')
    await beta.into(schema.migration_parents).insert({ id: 'shared-parent', name: 'beta parent' })
    await beta.into(schema.migration_children).insert({
      id: 'shared-child',
      parentId: 'shared-parent',
      name: 'beta child',
    })

    const tenantBoundaryError = await databaseCause(
      tracked.withTenant('gamma').into(schema.migration_children).insert({
        id: 'orphan',
        parentId: 'shared-parent',
        name: 'must remain tenant-local',
      }),
    )
    expect(tenantBoundaryError.message).toMatch(/foreign key/i)

    const primaryKeys = await client.query<{ table_name: string; columns: string }>(`
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
        AND relation.relname IN ('migration_parents', 'migration_children')
      GROUP BY relation.relname
      ORDER BY relation.relname
    `)
    expect(primaryKeys.rows).toEqual([
      { table_name: 'migration_children', columns: 'workspace_id,id' },
      { table_name: 'migration_parents', columns: 'workspace_id,id' },
    ])
    expect(await migrateTenantPrimaryKeys(db, schema)).toEqual({
      migrated: [],
      alreadyCurrent: ['migration_children', 'migration_parents'],
    })
  })

  test('names global-ID foreign keys and leaves the legacy primary key untouched', async () => {
    const client = createTestDatabase()
    await client.waitReady
    await client.exec(`
      CREATE TABLE unsafe_migration_parents (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        CONSTRAINT unsafe_migration_parents_workspace_id_id_unique UNIQUE (workspace_id, id)
      );
      CREATE TABLE external_children (
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        CONSTRAINT external_children_parent_fk
          FOREIGN KEY (parent_id) REFERENCES unsafe_migration_parents (id)
      );
    `)
    const db = drizzle(client)
    await syncSchema(db, unsafeSchema)

    await expect(migrateTenantPrimaryKeys(db, unsafeSchema)).rejects.toThrow(
      /external_children\.external_children_parent_fk.*include "workspace_id"/,
    )

    const primaryKey = await client.query<{ columns: string }>(`
      SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality) AS columns
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN LATERAL unnest(constraint_record.conkey)
        WITH ORDINALITY AS key_column(attribute_number, ordinality) ON TRUE
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum = key_column.attribute_number
      WHERE constraint_record.contype = 'p'
        AND relation.relname = 'unsafe_migration_parents'
      GROUP BY relation.relname
    `)
    expect(primaryKey.rows).toEqual([{ columns: 'id' }])
  })

  test('rejects global-ID foreign keys on an already-composite primary key', async () => {
    const client = createTestDatabase()
    await client.waitReady
    await client.exec(`
      CREATE TABLE current_dependency_parents (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        CONSTRAINT current_dependency_parents_pkey PRIMARY KEY (workspace_id, id),
        CONSTRAINT current_dependency_parents_id_unique UNIQUE (id)
      );
      CREATE TABLE current_dependency_children (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL,
        CONSTRAINT current_dependency_children_parent_fk
          FOREIGN KEY (parent_id) REFERENCES current_dependency_parents (id)
      );
      INSERT INTO current_dependency_parents VALUES ('alpha', 'shared', 'alpha parent');
      INSERT INTO current_dependency_children VALUES ('beta', 'beta child', 'shared');
    `)

    await expect(
      migrateTenantPrimaryKeys(drizzle(client), currentDependencySchema),
    ).rejects.toThrow(
      /current_dependency_children\.current_dependency_children_parent_fk.*include "workspace_id"/,
    )

    const crossTenantReference = await client.query<{ workspace_id: string; parent_id: string }>(`
      SELECT workspace_id, parent_id FROM current_dependency_children
    `)
    expect(crossTenantReference.rows).toEqual([{ workspace_id: 'beta', parent_id: 'shared' }])
  })

  test('rejects standalone global uniqueness atomically before accepting current shape', async () => {
    const client = createTestDatabase()
    await client.waitReady
    await client.exec(`
      CREATE TABLE a_atomic_legacy_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        CONSTRAINT a_atomic_legacy_accounts_workspace_id_id_unique UNIQUE (workspace_id, id)
      );
      CREATE TABLE z_atomic_current_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        CONSTRAINT z_atomic_current_accounts_pkey PRIMARY KEY (workspace_id, id),
        CONSTRAINT z_atomic_current_accounts_id_unique UNIQUE (id)
      );
      INSERT INTO a_atomic_legacy_accounts VALUES ('alpha', 'shared', 'legacy alpha');
      INSERT INTO z_atomic_current_accounts VALUES ('alpha', 'shared', 'current alpha');
    `)
    const db = drizzle(client)

    await expect(migrateTenantPrimaryKeys(db, atomicShapeSchema)).rejects.toThrow(
      /constraint "z_atomic_current_accounts_id_unique".*supported current shape.*no standalone UNIQUE \(id\)/,
    )

    // The valid legacy table sorts before the invalid current table. Its
    // unchanged key proves preflight failure cannot partially contract a schema.
    const primaryBeforeCleanup = await client.query<{ columns: string }>(`
      SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality) AS columns
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN LATERAL unnest(constraint_record.conkey)
        WITH ORDINALITY AS key_column(attribute_number, ordinality) ON TRUE
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum = key_column.attribute_number
      WHERE constraint_record.contype = 'p'
        AND relation.relname = 'a_atomic_legacy_accounts'
      GROUP BY relation.relname
    `)
    expect(primaryBeforeCleanup.rows).toEqual([{ columns: 'id' }])

    await client.exec(`
      ALTER TABLE z_atomic_current_accounts
        DROP CONSTRAINT z_atomic_current_accounts_id_unique
    `)
    expect(await migrateTenantPrimaryKeys(db, atomicShapeSchema)).toEqual({
      migrated: ['a_atomic_legacy_accounts'],
      alreadyCurrent: ['z_atomic_current_accounts'],
    })

    await client.exec(`
      INSERT INTO a_atomic_legacy_accounts VALUES ('beta', 'shared', 'legacy beta');
      INSERT INTO z_atomic_current_accounts VALUES ('beta', 'shared', 'current beta');
    `)
    const rowCounts = await client.query<{ legacy: number; current: number }>(`
      SELECT (SELECT count(*)::integer FROM a_atomic_legacy_accounts) AS legacy,
             (SELECT count(*)::integer FROM z_atomic_current_accounts) AS current
    `)
    expect(rowCounts.rows).toEqual([{ legacy: 2, current: 2 }])
  })

  test('rejects a compatibility model that has not declared the target primary key', async () => {
    const records = pgTable(
      'compatibility_migration_records',
      {
        workspaceId: pgText('workspace_id').notNull(),
        id: pgText('id').primaryKey(),
      },
      (row) => [
        unique('compatibility_migration_records_workspace_id_id_unique').on(
          row.workspaceId,
          row.id,
        ),
      ],
    )
    const compatibilitySchema = adoptSchema(tenancy, {
      records: {
        table: records,
        logicalPrimaryKey: 'id',
        identity: 'global-primary-compatibility',
      },
    })
    const client = createTestDatabase()
    await client.waitReady

    await expect(migrateTenantPrimaryKeys(drizzle(client), compatibilitySchema)).rejects.toThrow(
      /requires target schema.*PRIMARY KEY \(workspace_id, id\)/,
    )
  })
})
