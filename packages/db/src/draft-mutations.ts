import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { tryGetTableCapabilities } from './schema'
import type { AnyTable, DraftDrizzleTracker, DrizzleDb, TenantScope } from './tracker-core'
import {
  assertDraftWriteScope,
  assertRevisionInput,
  assertTenantInput,
  draftCastType,
  draftChangesRelation,
  draftTableTrackingTag,
  encodeProposedDraftValue,
  encodeTypedKey,
  noTenantScope,
  quoteSqlIdentifier,
  requireColumn,
  requireTenantScope,
  revisionProperty,
  sqlLiteral,
  withoutUndefined,
} from './tracker-core'
import { mapColumnValue, normalizeExecuteRows, resolvePkColumnName } from './tracker-codecs'

export async function writeDraftRow(
  db: DrizzleDb,
  tracker: { tablesWritten: Set<string> },
  table: AnyTable,
  draftId: string,
  tenantScope: TenantScope,
  opts: {
    pkValue: unknown
    values: Record<string, unknown>
    tombstone: boolean
    intent: 'insert' | 'update' | 'delete'
  },
): Promise<Record<string, unknown>[]> {
  const tableName = getTableName(table)
  const config = getTableConfig(table)
  const pkColName = resolvePkColumnName(table, config)
  const schema = config.schema
  const tableKey = schema ? `${schema}.${tableName}` : tableName
  const baseRel = schema
    ? `${quoteSqlIdentifier(schema)}.${quoteSqlIdentifier(tableName)}`
    : quoteSqlIdentifier(tableName)

  // Route the PK value through its column codec too, so a PK whose type has a
  // non-identity codec binds identically to the canonical path. PKs are
  // typically uuid/text/serial (identity codec → no-op), but routing rather than
  // assuming keeps the write path codec-correct for any PK column type.
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  const columns = getTableColumns(table) as Record<string, any>
  const pkCol = Object.values(columns).find((c) => (c.name as string) === pkColName)
  if (!pkCol) throw new Error(`Cannot resolve primary key column for "${tableKey}"`)
  const pkValue = mapColumnValue(pkCol, opts.pkValue)
  const rowKey = encodeTypedKey(pkCol, opts.pkValue)
  const tenant = requireTenantScope(table, tenantScope)
  const tenantColumn = tenant ? requireColumn(columns, tenant.tenancy.property) : undefined
  const tenantValue = tenantColumn ? mapColumnValue(tenantColumn, tenant?.tenantId) : undefined
  const tenantKey = tenantColumn
    ? encodeTypedKey(tenantColumn, tenant?.tenantId)
    : { envelope: null, text: '' }

  const valueCols = Object.entries(opts.values).flatMap(([property, value]) => {
    if (value === undefined || !Object.hasOwn(columns, property)) return []
    const column = columns[property]
    const sqlName = column.name as string
    if (sqlName === pkColName || sqlName === tenant?.tenancy.column) return []
    return [{ column, sqlName, proposed: encodeProposedDraftValue(column, value) }]
  })

  const basePredicates: SQL[] = [
    sql`${sql.raw(`${quoteSqlIdentifier(pkColName)} = `)}${sql.param(pkValue)}`,
  ]
  if (tenant && tenantColumn) {
    basePredicates.push(
      sql`${sql.raw(`${quoteSqlIdentifier(tenantColumn.name)} = `)}${sql.param(tenantValue)}`,
    )
  }
  const baseCte = sql`${sql.raw(`WITH base AS (SELECT * FROM ${baseRel} WHERE `)}${sql.join(
    basePredicates,
    sql.raw(' AND '),
  )}${sql.raw(' FOR UPDATE) ')}`

  const basePresent = `b.${quoteSqlIdentifier(pkColName)} IS NOT NULL`
  const fieldPairs = valueCols.flatMap(({ column, sqlName, proposed }, index) => {
    const kind = ['json', 'jsonb'].includes(draftCastType(column)) ? 'json' : 'value'
    const original =
      `CASE WHEN NOT (${basePresent}) THEN '{"kind":"absent"}'::jsonb ` +
      `WHEN b.${quoteSqlIdentifier(sqlName)} IS NULL THEN '{"kind":"sql-null"}'::jsonb ` +
      `ELSE jsonb_build_object('kind', ${sqlLiteral(kind)}, 'value', to_jsonb(b.${quoteSqlIdentifier(sqlName)})) END`
    const separator = index === 0 ? '' : ', '
    return [
      sql`${sql.raw(
        `${separator}${sqlLiteral(sqlName)}, jsonb_build_object('original', ${original}, 'value', `,
      )}${sql.param(JSON.stringify(proposed))}${sql.raw('::jsonb)')}`,
    ]
  })
  const fieldsExpression = fieldPairs.length
    ? sql`${sql.raw('jsonb_build_object(')}${sql.join(fieldPairs, sql.raw(''))}${sql.raw(')')}`
    : sql.raw("'{}'::jsonb")

  const revisionProperty = tryGetTableCapabilities(table)?.revisionProperty
  const revisionColumn = revisionProperty ? requireColumn(columns, revisionProperty) : undefined
  const baseRevision = revisionColumn
    ? sql.raw(`to_jsonb(b.${quoteSqlIdentifier(revisionColumn.name as string)})`)
    : sql.raw('NULL::jsonb')
  const tenantJson = tenantColumn
    ? sql`${sql.param(JSON.stringify(tenantKey.envelope))}${sql.raw('::jsonb')}`
    : sql.raw('NULL::jsonb')
  const operation = opts.tombstone ? 'delete' : opts.intent

  const query = sql`${baseCte}${sql.raw(
    `INSERT INTO ${draftChangesRelation} ` +
      `("draft_id", "table_key", "tenant_key_text", "tenant_key", "row_key_text", "row_key", ` +
      `"operation", "base_exists", "base_revision", "fields") SELECT `,
  )}${sql.param(draftId)}${sql.raw(', ')}${sql.param(tableKey)}${sql.raw(', ')}${sql.param(
    tenantKey.text,
  )}${sql.raw(', ')}${tenantJson}${sql.raw(', ')}${sql.param(rowKey.text)}${sql.raw(
    ', ',
  )}${sql.param(JSON.stringify(rowKey.envelope))}${sql.raw('::jsonb, ')}${sql.param(
    operation,
  )}${sql.raw(`, ${basePresent}, `)}${baseRevision}${sql.raw(', ')}${fieldsExpression}${sql.raw(
    ` FROM (SELECT 1) seed LEFT JOIN base b ON TRUE ` +
      `ON CONFLICT ("draft_id", "table_key", "tenant_key_text", "row_key_text") DO UPDATE SET ` +
      `"operation" = CASE ` +
      `WHEN EXCLUDED."operation" = 'delete' THEN 'delete' ` +
      `WHEN ${draftChangesRelation}."operation" = 'insert' THEN 'insert' ` +
      `ELSE EXCLUDED."operation" END, ` +
      `"fields" = ${draftChangesRelation}."fields" || COALESCE((` +
      `SELECT jsonb_object_agg(entry.key, CASE ` +
      `WHEN ${draftChangesRelation}."fields" ? entry.key ` +
      `THEN jsonb_set(${draftChangesRelation}."fields" -> entry.key, '{value}', entry.value -> 'value', true) ` +
      `ELSE entry.value END) FROM jsonb_each(EXCLUDED."fields") entry` +
      `), '{}'::jsonb) RETURNING *`,
  )}`

  const result = await db.execute(query)
  tracker.tablesWritten.add(draftTableTrackingTag(table, tenantScope, draftId))
  return normalizeExecuteRows(result)
}

function materializeDraftInsertDefaults(
  // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle columns
  columns: Record<string, any>,
  supplied: Record<string, unknown>,
  pkProperty: string,
): Record<string, unknown> {
  const row = withoutUndefined(supplied)
  for (const [property, column] of Object.entries(columns)) {
    if (property === pkProperty || Object.hasOwn(row, property) || !column.hasDefault) continue
    if (typeof column.defaultFn === 'function') {
      throw new Error(
        `Draft insert default for "${property}" is generated at execution time; resolve it into the command input so publish reuses the same value`,
      )
    }
    if (column.default === undefined) continue
    if (
      column.default !== null &&
      typeof column.default === 'object' &&
      typeof column.default.getSQL === 'function'
    ) {
      throw new Error(
        `Draft insert default for "${property}" is generated by SQL; resolve it into the command input so publish reuses the same value`,
      )
    }
    row[property] = column.default
  }
  return row
}

/**
 * Insert builder returned by `DraftDrizzleTracker.into(table)`. Routes
 * `.insert(rows)` into the central change relation as a sparse upsert per row
 * (each row carrying the full PK + columns and `operation = 'insert'`). Mirrors the
 * canonical `into(table).insert(...)` a command handler emits — the handler is
 * unaware it is inserting into a draft.
 */
export class DraftInsertBuilder<T extends AnyTable> {
  private _table: T
  private _db: DrizzleDb
  private _draftId: string
  private _tracker: DraftDrizzleTracker
  private _tenantScope: TenantScope

  constructor(
    table: T,
    db: DrizzleDb,
    draftId: string,
    tracker: DraftDrizzleTracker,
    tenantScope: TenantScope = noTenantScope,
  ) {
    this._table = table
    this._db = db
    this._draftId = draftId
    this._tracker = tracker
    this._tenantScope = tenantScope
  }

  async insert(
    values: T['$inferInsert'] | T['$inferInsert'][],
  ): Promise<Record<string, unknown>[]> {
    assertDraftWriteScope(this._table, this._tenantScope)
    const rows = Array.isArray(values) ? values : [values]
    const config = getTableConfig(this._table)
    const pkColName = resolvePkColumnName(this._table, config)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const pkPropKey = Object.keys(columns).find((k) => (columns[k].name as string) === pkColName)

    const out: Record<string, unknown>[] = []
    for (const row of rows) {
      const supplied = row as Record<string, unknown>
      assertRevisionInput(this._table, supplied)
      const revision = revisionProperty(this._table)
      const withRevision = revision ? { ...supplied, [revision]: 1 } : supplied
      const r = materializeDraftInsertDefaults(columns, withRevision, pkPropKey ?? pkColName)
      assertTenantInput(this._table, r)
      const pkValue = pkPropKey !== undefined ? r[pkPropKey] : r[pkColName]
      if (pkValue === undefined || pkValue === null) {
        throw new Error(
          `DraftInsertBuilder.insert(): row is missing primary key "${pkPropKey ?? pkColName}". ` +
            `Draft inserts require a client-minted PK so the derived row is addressable.`,
        )
      }
      // Pass the full row as sparse values; writeDraftRow drops the PK column,
      // which is carried separately as the stable row identity.
      await writeDraftRow(this._db, this._tracker, this._table, this._draftId, this._tenantScope, {
        pkValue,
        values: r,
        tombstone: false,
        intent: 'insert',
      })
      const effective = await this._tracker
        .from(this._table)
        .where({ op: 'eq', column: pkPropKey ?? pkColName, value: pkValue })
        .first()
      if (effective) out.push(effective)
    }
    return out
  }
}
