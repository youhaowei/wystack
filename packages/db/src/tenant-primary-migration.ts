import { getTableName, sql, type SQL } from 'drizzle-orm'
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import { tryGetLogicalPrimaryKeyColumn, tryGetTableCapabilities } from './schema'
import { normalizeExecuteRows } from './tracker-codecs'

interface MigrationTransaction {
  execute(statement: SQL): Promise<unknown>
}

/** A Drizzle database capable of keeping the complete identity migration atomic. */
export interface TenantPrimaryKeyMigrationTarget extends MigrationTransaction {
  transaction<T>(operation: (tx: MigrationTransaction) => Promise<T>): Promise<T>
}

export interface TenantPrimaryKeyMigrationResult {
  migrated: string[]
  alreadyCurrent: string[]
}

interface TenantIdentity {
  tableName: string
  tenantColumn: string
  logicalColumn: string
}

interface PrimaryKeyRow extends Record<string, unknown> {
  constraint_name: string
  column_names: string
}

interface GlobalIdentityUniqueness {
  kind: 'constraint' | 'index'
  name: string
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

function tenantIdentities(schema: Record<string, PgTable>): TenantIdentity[] {
  const identities: TenantIdentity[] = []
  const seen = new Set<PgTable>()

  for (const table of Object.values(schema)) {
    if (seen.has(table)) continue
    seen.add(table)
    const tenancy = tryGetTableCapabilities(table)?.tenancy
    if (!tenancy) continue
    const config = getTableConfig(table)
    if (config.schema !== undefined) {
      throw new Error(
        `Tenant-primary migration does not support schema-qualified table "${getTableName(table)}"`,
      )
    }
    const logicalColumn = tryGetLogicalPrimaryKeyColumn(table)
    if (!logicalColumn) {
      throw new Error(
        `Tenant-primary migration cannot resolve the logical identity for "${getTableName(table)}"`,
      )
    }
    const desiredPrimary = [tenancy.column, logicalColumn]
    const modelsTenantPrimary =
      config.primaryKeys.length === 1 &&
      config.primaryKeys[0]!.columns.length === desiredPrimary.length &&
      config.primaryKeys[0]!.columns.every(
        (column, index) => column.name === desiredPrimary[index],
      ) &&
      config.columns.every((column) => !column.primary)
    if (!modelsTenantPrimary) {
      throw new Error(
        `Tenant-primary migration requires target schema "${getTableName(table)}" to model ` +
          `PRIMARY KEY (${desiredPrimary.join(', ')}); remove global-primary-compatibility ` +
          `only after the application migration declares that target shape`,
      )
    }
    identities.push({
      tableName: getTableName(table),
      tenantColumn: tenancy.column,
      logicalColumn,
    })
  }

  return identities.sort((left, right) => left.tableName.localeCompare(right.tableName))
}

async function identityColumnsAreRequired(
  tx: MigrationTransaction,
  identity: TenantIdentity,
): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT attribute.attname AS column_name, attribute.attnotnull AS is_required
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ${identity.tableName}
      AND attribute.attname IN (${identity.tenantColumn}, ${identity.logicalColumn})
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  `)
  const rows = normalizeExecuteRows(result)
  if (rows.length !== 2) {
    throw new Error(
      `Tenant-primary migration requires existing table "${identity.tableName}" with columns ` +
        `(${identity.tenantColumn}, ${identity.logicalColumn}); run syncSchema() first`,
    )
  }
  return rows.every((row) => row['is_required'] === true)
}

async function primaryKey(
  tx: MigrationTransaction,
  identity: TenantIdentity,
): Promise<PrimaryKeyRow> {
  const result = await tx.execute(sql`
    SELECT constraint_record.conname AS constraint_name,
           string_agg(attribute.attname, ',' ORDER BY key_column.ordinality) AS column_names
    FROM pg_constraint AS constraint_record
    JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN LATERAL unnest(constraint_record.conkey)
      WITH ORDINALITY AS key_column(attribute_number, ordinality) ON TRUE
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum = key_column.attribute_number
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ${identity.tableName}
      AND constraint_record.contype = 'p'
    GROUP BY constraint_record.conname
  `)
  const rows = normalizeExecuteRows(result)
  if (rows.length !== 1) {
    throw new Error(
      `Tenant-primary migration requires exactly one primary key on "${identity.tableName}"`,
    )
  }
  return rows[0] as PrimaryKeyRow
}

async function hasTenantUniqueIndex(
  tx: MigrationTransaction,
  identity: TenantIdentity,
): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT string_agg(attribute.attname, ',' ORDER BY key_column.ordinality) AS column_names
    FROM pg_index AS index_record
    JOIN pg_class AS relation ON relation.oid = index_record.indrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN LATERAL unnest(index_record.indkey)
      WITH ORDINALITY AS key_column(attribute_number, ordinality)
      ON key_column.ordinality <= index_record.indnkeyatts
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = relation.oid
     AND attribute.attnum = key_column.attribute_number
    WHERE namespace.nspname = current_schema()
      AND relation.relname = ${identity.tableName}
      AND index_record.indisunique
      AND index_record.indpred IS NULL
      AND index_record.indexprs IS NULL
    GROUP BY index_record.indexrelid
  `)
  const expected = `${identity.tenantColumn},${identity.logicalColumn}`
  return normalizeExecuteRows(result).some((row) => row['column_names'] === expected)
}

async function globalIdentityDependents(
  tx: MigrationTransaction,
  identity: TenantIdentity,
): Promise<string[]> {
  const result = await tx.execute(sql`
    SELECT child_namespace.nspname AS child_schema,
           child_relation.relname AS child_table,
           foreign_key.conname AS constraint_name,
           string_agg(parent_attribute.attname, ',' ORDER BY parent_key.ordinality)
             AS referenced_columns
    FROM pg_constraint AS foreign_key
    JOIN pg_class AS parent_relation ON parent_relation.oid = foreign_key.confrelid
    JOIN pg_namespace AS parent_namespace ON parent_namespace.oid = parent_relation.relnamespace
    JOIN pg_class AS child_relation ON child_relation.oid = foreign_key.conrelid
    JOIN pg_namespace AS child_namespace ON child_namespace.oid = child_relation.relnamespace
    JOIN LATERAL unnest(foreign_key.confkey)
      WITH ORDINALITY AS parent_key(attribute_number, ordinality) ON TRUE
    JOIN pg_attribute AS parent_attribute
      ON parent_attribute.attrelid = parent_relation.oid
     AND parent_attribute.attnum = parent_key.attribute_number
    WHERE parent_namespace.nspname = current_schema()
      AND parent_relation.relname = ${identity.tableName}
      AND foreign_key.contype = 'f'
    GROUP BY child_namespace.nspname, child_relation.relname, foreign_key.conname
    HAVING string_agg(parent_attribute.attname, ',' ORDER BY parent_key.ordinality) =
      ${identity.logicalColumn}
  `)
  return normalizeExecuteRows(result).map(
    (row) =>
      `${String(row['child_schema'])}.${String(row['child_table'])}.${String(row['constraint_name'])}`,
  )
}

async function globalIdentityUniqueness(
  tx: MigrationTransaction,
  identity: TenantIdentity,
): Promise<GlobalIdentityUniqueness[]> {
  // pg_depend attaches key expressions, predicates, and INCLUDE columns to the
  // index object. Discount known logical-ID INCLUDE occurrences, then fail
  // closed on a remaining logical-ID or whole-relation dependency unless tenant
  // identity is a direct key.
  const result = await tx.execute(sql`
    WITH candidate_indexes AS (
      SELECT index_record.indexrelid,
             index_record.indrelid,
             index_record.indkey,
             index_record.indnkeyatts,
             index_record.indexprs,
             logical_attribute.attnum AS logical_attribute_number,
             tenant_attribute.attnum AS tenant_attribute_number,
             CASE WHEN unique_constraint.oid IS NULL THEN 'index' ELSE 'constraint' END
               AS object_kind,
             COALESCE(unique_constraint.conname, index_relation.relname) AS object_name
      FROM pg_index AS index_record
      JOIN pg_class AS relation ON relation.oid = index_record.indrelid
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN pg_class AS index_relation ON index_relation.oid = index_record.indexrelid
      JOIN pg_attribute AS logical_attribute
        ON logical_attribute.attrelid = relation.oid
       AND logical_attribute.attname = ${identity.logicalColumn}
       AND logical_attribute.attnum > 0
       AND NOT logical_attribute.attisdropped
      JOIN pg_attribute AS tenant_attribute
        ON tenant_attribute.attrelid = relation.oid
       AND tenant_attribute.attname = ${identity.tenantColumn}
       AND tenant_attribute.attnum > 0
       AND NOT tenant_attribute.attisdropped
      LEFT JOIN pg_constraint AS unique_constraint
        ON unique_constraint.conindid = index_record.indexrelid
       AND unique_constraint.contype = 'u'
      WHERE namespace.nspname = current_schema()
        AND relation.relname = ${identity.tableName}
        AND index_record.indisunique
        AND NOT index_record.indisprimary
        AND index_record.indisready
        AND index_record.indislive
    ),
    generated_identity_attributes AS (
      SELECT DISTINCT candidate.indrelid,
             generated_attribute.attnum AS attribute_number
      FROM candidate_indexes AS candidate
      JOIN pg_attribute AS generated_attribute
        ON generated_attribute.attrelid = candidate.indrelid
       AND generated_attribute.attgenerated <> ''
       AND generated_attribute.attnum > 0
       AND NOT generated_attribute.attisdropped
      JOIN pg_attrdef AS generated_definition
        ON generated_definition.adrelid = generated_attribute.attrelid
       AND generated_definition.adnum = generated_attribute.attnum
      WHERE EXISTS (
        SELECT 1
        FROM pg_depend AS dependency
        WHERE dependency.classid = 'pg_attrdef'::regclass
          AND dependency.objid = generated_definition.oid
          AND dependency.refclassid = 'pg_class'::regclass
          AND dependency.refobjid = candidate.indrelid
          AND dependency.refobjsubid IN (0, candidate.logical_attribute_number)
      )
    ),
    identity_derived_attributes AS (
      SELECT DISTINCT indrelid, logical_attribute_number AS attribute_number
      FROM candidate_indexes
      UNION
      SELECT indrelid, attribute_number
      FROM generated_identity_attributes
    ),
    direct_global_identity AS (
      SELECT candidate.object_kind, candidate.object_name
      FROM candidate_indexes AS candidate
      WHERE candidate.indexprs IS NULL
        AND (
          NOT EXISTS (
            SELECT 1
            FROM unnest(candidate.indkey)
              WITH ORDINALITY AS key_column(attribute_number, ordinality)
            WHERE key_column.ordinality <= candidate.indnkeyatts
              AND key_column.attribute_number <> candidate.logical_attribute_number
          )
          OR (
            EXISTS (
              SELECT 1
              FROM unnest(candidate.indkey)
                WITH ORDINALITY AS key_column(attribute_number, ordinality)
              JOIN generated_identity_attributes AS generated_attribute
                ON generated_attribute.indrelid = candidate.indrelid
               AND generated_attribute.attribute_number = key_column.attribute_number
              WHERE key_column.ordinality <= candidate.indnkeyatts
            )
            AND NOT EXISTS (
              SELECT 1
              FROM unnest(candidate.indkey)
                WITH ORDINALITY AS key_column(attribute_number, ordinality)
              WHERE key_column.ordinality <= candidate.indnkeyatts
                AND key_column.attribute_number = candidate.tenant_attribute_number
            )
          )
        )
    ),
    expression_global_identity AS (
      SELECT candidate.object_kind, candidate.object_name
      FROM candidate_indexes AS candidate
      WHERE candidate.indexprs IS NOT NULL
        AND (
          EXISTS (
            SELECT 1
            FROM identity_derived_attributes AS derived_attribute
            WHERE derived_attribute.indrelid = candidate.indrelid
              AND (
                SELECT count(*)
                FROM pg_depend AS dependency
                WHERE dependency.classid = 'pg_class'::regclass
                  AND dependency.objid = candidate.indexrelid
                  AND dependency.refclassid = 'pg_class'::regclass
                  AND dependency.refobjid = candidate.indrelid
                  AND dependency.refobjsubid = derived_attribute.attribute_number
              ) > (
                SELECT count(*)
                FROM unnest(candidate.indkey)
                  WITH ORDINALITY AS included_column(attribute_number, ordinality)
                WHERE included_column.ordinality > candidate.indnkeyatts
                  AND included_column.attribute_number = derived_attribute.attribute_number
              )
          )
          OR EXISTS (
            SELECT 1
            FROM pg_depend AS dependency
            WHERE dependency.classid = 'pg_class'::regclass
              AND dependency.objid = candidate.indexrelid
              AND dependency.refclassid = 'pg_class'::regclass
              AND dependency.refobjid = candidate.indrelid
              AND dependency.refobjsubid = 0
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM unnest(candidate.indkey)
            WITH ORDINALITY AS key_column(attribute_number, ordinality)
          WHERE key_column.ordinality <= candidate.indnkeyatts
            AND key_column.attribute_number = candidate.tenant_attribute_number
        )
    )
    SELECT object_kind, object_name FROM direct_global_identity
    UNION
    SELECT object_kind, object_name FROM expression_global_identity
    ORDER BY object_name
  `)
  return normalizeExecuteRows(result).map((row) => ({
    kind: row['object_kind'] === 'constraint' ? 'constraint' : 'index',
    name: String(row['object_name']),
  }))
}

/**
 * Contract the v0.2 global-primary compatibility shape into tenant-qualified
 * physical identity. This is deliberately separate from syncSchema(): callers
 * must run it once with a migration-capable role after syncSchema has ensured
 * every declared table exists and before the new application starts serving.
 *
 * Supported legacy shape:
 *   PRIMARY KEY (logical_id)
 *   UNIQUE (tenant_id, logical_id)
 *
 * Tenant-qualified foreign keys remain backed by the retained UNIQUE index.
 * A foreign key that still references only the global logical ID blocks the
 * migration with its exact constraint name; callers must expand that relation
 * to include tenant identity before retrying. The catalog preflight inspects
 * ready/live unique indexes, including direct keys, expressions, whole-row
 * dependencies, and generated-column lineage. Ambiguous derived identity must
 * have a direct tenant key. This does not prove arbitrary trigger or custom
 * runtime behavior. The supplied Drizzle schema must already model the target
 * composite primary key; the temporary adopted `global-primary-compatibility`
 * model is rejected so code and storage cannot silently disagree after the
 * contract step.
 */
export async function migrateTenantPrimaryKeys(
  db: TenantPrimaryKeyMigrationTarget,
  schema: Record<string, PgTable>,
): Promise<TenantPrimaryKeyMigrationResult> {
  const identities = tenantIdentities(schema)
  return db.transaction(async (tx) => {
    const plans: Array<TenantIdentity & { primaryKeyName: string }> = []
    const alreadyCurrent: string[] = []

    for (const identity of identities) {
      if (!(await identityColumnsAreRequired(tx, identity))) {
        throw new Error(
          `Tenant-primary migration requires NOT NULL identity columns on "${identity.tableName}"`,
        )
      }
      const currentPrimary = await primaryKey(tx, identity)
      const desiredColumns = `${identity.tenantColumn},${identity.logicalColumn}`
      const dependents = await globalIdentityDependents(tx, identity)
      if (dependents.length > 0) {
        throw new Error(
          `Tenant-primary migration cannot finalize "${identity.tableName}" while foreign keys ` +
            `still reference only "${identity.logicalColumn}": ${dependents.join(', ')}. ` +
            `Expand each foreign key to include "${identity.tenantColumn}" first`,
        )
      }
      const globalUniqueness = await globalIdentityUniqueness(tx, identity)
      if (globalUniqueness.length > 0) {
        const evidence = globalUniqueness.map(({ kind, name }) => `${kind} "${name}"`).join(', ')
        throw new Error(
          `Tenant-primary migration rejects unsupported identity shape on ` +
            `"${identity.tableName}": ${evidence} still enforces global identity ` +
            `(${identity.logicalColumn}). The supported legacy and current shapes allow neither ` +
            `a direct UNIQUE key made only of (${identity.logicalColumn}) slots nor, without a ` +
            `direct (${identity.tenantColumn}) key attribute, a UNIQUE key that uses an ` +
            `(${identity.logicalColumn})-derived generated column or has a residual ` +
            `(${identity.logicalColumn}), generated-column, or relation-level expression dependency`,
        )
      }
      if (currentPrimary.column_names === desiredColumns) {
        alreadyCurrent.push(identity.tableName)
        continue
      }
      if (currentPrimary.column_names !== identity.logicalColumn) {
        throw new Error(
          `Tenant-primary migration cannot upgrade "${identity.tableName}" from primary key ` +
            `(${currentPrimary.column_names}); expected (${identity.logicalColumn}) or (${desiredColumns})`,
        )
      }
      if (!(await hasTenantUniqueIndex(tx, identity))) {
        throw new Error(
          `Tenant-primary migration requires a non-partial unique index on ` +
            `"${identity.tableName}" (${desiredColumns}) before dropping the global primary key`,
        )
      }
      plans.push({
        ...identity,
        primaryKeyName: currentPrimary.constraint_name,
      })
    }

    for (const plan of plans) {
      await tx.execute(
        sql.raw(
          `ALTER TABLE ${quoteIdent(plan.tableName)}\n` +
            `  DROP CONSTRAINT ${quoteIdent(plan.primaryKeyName)},\n` +
            `  ADD CONSTRAINT ${quoteIdent(plan.primaryKeyName)} ` +
            `PRIMARY KEY (${quoteIdent(plan.tenantColumn)}, ${quoteIdent(plan.logicalColumn)})`,
        ),
      )
    }

    return {
      migrated: plans.map((plan) => plan.tableName),
      alreadyCurrent,
    }
  })
}
