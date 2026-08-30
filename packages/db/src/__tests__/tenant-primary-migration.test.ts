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

const includedExpandSchema = defineSchema({
  included_expand_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
})

const expressionShapeSchema = defineSchema({
  a_expression_legacy_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
  z_expression_current_accounts: tenancy.table({ id: text.primaryKey(), name: text }),
})

const currentExpressionIndexCases = [
  {
    suffix: 'identity',
    definition: `(((id || '')))`,
  },
  {
    suffix: 'identity_include',
    definition: `(((id || ''))) INCLUDE (id)`,
  },
  {
    suffix: 'identity_multikey',
    definition: `(((id || '')), ((length(id))))`,
  },
  {
    suffix: 'encoded_tenant',
    definition: `(((workspace_id || ':' || id)))`,
  },
] as const

const residualLegacyIndexCases = [
  {
    contract: 'a standalone logical-ID index',
    suffix: 'plain',
    indexDefinition: '(id)',
  },
  {
    contract: 'a logical-ID index with INCLUDE columns',
    suffix: 'include',
    indexDefinition: '(id) INCLUDE (name)',
  },
  {
    contract: 'a partial logical-ID index',
    suffix: 'partial',
    indexDefinition: `(id) WHERE name <> 'excluded'`,
  },
] as const

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

  test('accepts a tenant-qualified expand index with non-key INCLUDE columns', async () => {
    const client = createTestDatabase()
    await client.waitReady
    await client.exec(`
      CREATE TABLE included_expand_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
      );
      CREATE UNIQUE INDEX included_expand_accounts_workspace_id_id_unique
        ON included_expand_accounts (workspace_id, id) INCLUDE (name);
      INSERT INTO included_expand_accounts VALUES ('alpha', 'shared', 'alpha');
    `)
    const db = drizzle(client)

    expect(await migrateTenantPrimaryKeys(db, includedExpandSchema)).toEqual({
      migrated: ['included_expand_accounts'],
      alreadyCurrent: [],
    })
    await client.exec(`
      INSERT INTO included_expand_accounts VALUES ('beta', 'shared', 'beta')
    `)
    const rows = await client.query<{ count: number }>(`
      SELECT count(*)::integer AS count FROM included_expand_accounts
    `)
    expect(rows.rows).toEqual([{ count: 2 }])
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
      /constraint "z_atomic_current_accounts_id_unique".*standalone UNIQUE \(id\).*\(workspace_id\) is a direct key attribute/,
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

  test('rejects expression-derived global identity across legacy and current shapes', async () => {
    const client = createTestDatabase()
    await client.waitReady
    await client.exec(`
      CREATE TABLE a_expression_legacy_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        CONSTRAINT a_expression_legacy_accounts_workspace_id_id_unique
          UNIQUE (workspace_id, id)
      );
      CREATE TABLE z_expression_current_accounts (
        workspace_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        CONSTRAINT z_expression_current_accounts_pkey PRIMARY KEY (workspace_id, id)
      );
      CREATE UNIQUE INDEX a_expression_legacy_name_unique_idx
        ON a_expression_legacy_accounts ((lower(name))) INCLUDE (id);
      CREATE UNIQUE INDEX a_expression_legacy_id_name_unique_idx
        ON a_expression_legacy_accounts (id, name);
      CREATE UNIQUE INDEX z_expression_current_name_partial_idx
        ON z_expression_current_accounts ((lower(name)))
        WHERE name <> 'excluded';
      CREATE UNIQUE INDEX z_expression_current_tenant_id_expression_idx
        ON z_expression_current_accounts (workspace_id, ((id || '')));
      INSERT INTO a_expression_legacy_accounts VALUES ('alpha', 'shared', 'legacy alpha');
      INSERT INTO z_expression_current_accounts VALUES ('alpha', 'shared', 'current alpha');
    `)
    const db = drizzle(client)

    for (const example of currentExpressionIndexCases) {
      const indexName = `z_expression_current_${example.suffix}_idx`
      await client.exec(`
        CREATE UNIQUE INDEX ${indexName}
          ON z_expression_current_accounts ${example.definition}
      `)
      const error = await databaseCause(migrateTenantPrimaryKeys(db, expressionShapeSchema))
      expect(error.message).toContain(`index "${indexName}"`)
      expect(error.message).toContain('(workspace_id) is a direct key attribute')
      await client.exec(`DROP INDEX ${indexName}`)
    }

    // The legacy table sorts first. Its global key remaining in place proves
    // the later current-shape rejection happens before any ALTER statement.
    const legacyPrimaryBeforeCleanup = await client.query<{ columns: string }>(`
      SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality) AS columns
      FROM pg_constraint AS constraint_record
      JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
      JOIN LATERAL unnest(constraint_record.conkey)
        WITH ORDINALITY AS key_column(attribute_number, ordinality) ON TRUE
      JOIN pg_attribute AS attribute
        ON attribute.attrelid = relation.oid
       AND attribute.attnum = key_column.attribute_number
      WHERE constraint_record.contype = 'p'
        AND relation.relname = 'a_expression_legacy_accounts'
      GROUP BY relation.relname
    `)
    expect(legacyPrimaryBeforeCleanup.rows).toEqual([{ columns: 'id' }])

    await client.exec(`
      CREATE UNIQUE INDEX a_expression_legacy_id_partial_idx
        ON a_expression_legacy_accounts (((id || ''))) INCLUDE (name)
        WHERE name <> 'excluded';
    `)
    await expect(migrateTenantPrimaryKeys(db, expressionShapeSchema)).rejects.toThrow(
      /index "a_expression_legacy_id_partial_idx".*\(workspace_id\) is a direct key attribute/,
    )

    await client.exec(`DROP INDEX a_expression_legacy_id_partial_idx`)
    expect(await migrateTenantPrimaryKeys(db, expressionShapeSchema)).toEqual({
      migrated: ['a_expression_legacy_accounts'],
      alreadyCurrent: ['z_expression_current_accounts'],
    })
    await client.exec(`
      INSERT INTO a_expression_legacy_accounts VALUES ('beta', 'shared', 'legacy beta');
      INSERT INTO z_expression_current_accounts VALUES ('beta', 'shared', 'current beta');
    `)
    expect(await migrateTenantPrimaryKeys(db, expressionShapeSchema)).toEqual({
      migrated: [],
      alreadyCurrent: ['a_expression_legacy_accounts', 'z_expression_current_accounts'],
    })
  })

  for (const example of residualLegacyIndexCases) {
    test(`rejects ${example.contract} before migrating a legacy primary key`, async () => {
      const validTable = `a_${example.suffix}_legacy_accounts`
      const residualTable = `z_${example.suffix}_legacy_accounts`
      const residualIndex = `${residualTable}_id_unique_idx`
      const legacySchema = defineSchema({
        [validTable]: tenancy.table({ id: text.primaryKey(), name: text }),
        [residualTable]: tenancy.table({ id: text.primaryKey(), name: text }),
      })
      const client = createTestDatabase()
      await client.waitReady
      await client.exec(`
        CREATE TABLE ${validTable} (
          workspace_id TEXT NOT NULL,
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          CONSTRAINT ${validTable}_workspace_id_id_unique UNIQUE (workspace_id, id)
        );
        CREATE TABLE ${residualTable} (
          workspace_id TEXT NOT NULL,
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          CONSTRAINT ${residualTable}_workspace_id_id_unique UNIQUE (workspace_id, id)
        );
        CREATE UNIQUE INDEX ${residualIndex}
          ON ${residualTable} ${example.indexDefinition};
        INSERT INTO ${validTable} VALUES ('alpha', 'shared', 'valid alpha');
        INSERT INTO ${residualTable} VALUES ('alpha', 'shared', 'residual alpha');
      `)
      const db = drizzle(client)

      const error = await databaseCause(migrateTenantPrimaryKeys(db, legacySchema))
      expect(error.message).toContain(`index "${residualIndex}"`)
      expect(error.message).toContain(
        'standalone UNIQUE (id) nor an expression-bearing UNIQUE index with a residual (id) dependency',
      )

      // The valid table sorts first. Both keys remaining global proves the
      // later preflight rejection cannot partially mutate an earlier plan.
      const primaryKeysBeforeCleanup = await client.query<{
        table_name: string
        columns: string
      }>(`
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
          AND relation.relname IN ('${validTable}', '${residualTable}')
        GROUP BY relation.relname
        ORDER BY relation.relname
      `)
      expect(primaryKeysBeforeCleanup.rows).toEqual([
        { table_name: validTable, columns: 'id' },
        { table_name: residualTable, columns: 'id' },
      ])

      await client.exec(`DROP INDEX ${residualIndex}`)
      expect(await migrateTenantPrimaryKeys(db, legacySchema)).toEqual({
        migrated: [validTable, residualTable],
        alreadyCurrent: [],
      })
      await client.exec(`
        INSERT INTO ${validTable} VALUES ('beta', 'shared', 'valid beta');
        INSERT INTO ${residualTable} VALUES ('beta', 'shared', 'residual beta');
      `)
      expect(await migrateTenantPrimaryKeys(db, legacySchema)).toEqual({
        migrated: [],
        alreadyCurrent: [validTable, residualTable],
      })
    })
  }

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
