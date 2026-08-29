import { getTableColumns, getTableName, isSQLWrapper, sql } from 'drizzle-orm'
import type { SQL, SQLChunk } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { tryGetTableCapabilities } from './schema'
import type {
  AnyTable,
  DraftDrizzleTracker,
  DrizzleDb,
  TenantScope,
  TrackedInsertValues,
} from './tracker-core'
import {
  assertDraftWriteScope,
  assertJsonNullInputs,
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
import { createDrizzleTracker } from './tracker-factory'
import { compareRowRevisionRows, lockRowRevision } from './row-revisions'

type DraftWriteIntent = 'insert' | 'update' | 'delete'

interface DraftWriteOptions {
  pkValue: unknown
  values: Record<string, unknown>
  tombstone: boolean
  intent: DraftWriteIntent
}

type DraftColumn = AnyPgColumn
type DraftColumns = Record<string, DraftColumn>

interface DraftRowTarget {
  tableKey: string
  baseRelation: string
  columns: DraftColumns
  pkColumnName: string
  pkProperty: string
  pkValue: unknown
  rowKey: ReturnType<typeof encodeTypedKey>
  tenantColumn?: DraftColumn
  tenantValue?: unknown
  tenantKey: ReturnType<typeof encodeTypedKey> | { envelope: null; text: '' }
  revisionColumn?: DraftColumn
}

interface DraftField {
  column: DraftColumn
  sqlName: string
  proposed: ReturnType<typeof encodeProposedDraftValue>
  plannedRevision: boolean
}

function resolveDraftRowTarget(
  table: AnyTable,
  tenantScope: TenantScope,
  pkInput: unknown,
): DraftRowTarget {
  const tableName = getTableName(table)
  const config = getTableConfig(table)
  const pkColumnName = resolvePkColumnName(table, config)
  const tableKey = config.schema ? `${config.schema}.${tableName}` : tableName
  const baseRelation = config.schema
    ? `${quoteSqlIdentifier(config.schema)}.${quoteSqlIdentifier(tableName)}`
    : quoteSqlIdentifier(tableName)

  const columns = getTableColumns(table) as DraftColumns
  const pkEntry = Object.entries(columns).find(([, column]) => column.name === pkColumnName)
  if (!pkEntry) throw new Error(`Cannot resolve primary key column for "${tableKey}"`)
  const [pkProperty, pkColumn] = pkEntry

  const tenant = requireTenantScope(table, tenantScope)
  const tenantColumn = tenant ? requireColumn(columns, tenant.tenancy.property) : undefined
  const revisionName = tryGetTableCapabilities(table)?.revisionProperty

  return {
    tableKey,
    baseRelation,
    columns,
    pkColumnName,
    pkProperty,
    // Route identity predicates through the same codec as canonical writes.
    pkValue: mapColumnValue(pkColumn, pkInput),
    rowKey: encodeTypedKey(pkColumn, pkInput),
    tenantColumn,
    tenantValue: tenantColumn ? mapColumnValue(tenantColumn, tenant?.tenantId) : undefined,
    tenantKey: tenantColumn
      ? encodeTypedKey(tenantColumn, tenant?.tenantId)
      : { envelope: null, text: '' },
    revisionColumn: revisionName ? requireColumn(columns, revisionName) : undefined,
  }
}

function collectDraftFields(
  target: DraftRowTarget,
  values: Record<string, unknown>,
  intent: DraftWriteIntent,
): DraftField[] {
  const fields = Object.entries(values).flatMap(([property, value]) => {
    if (value === undefined || !Object.hasOwn(target.columns, property)) return []
    const column = target.columns[property]
    const sqlName = column.name as string
    if (sqlName === target.pkColumnName || sqlName === target.tenantColumn?.name) return []
    if (intent === 'insert' && sqlName === target.revisionColumn?.name) return []
    return [
      {
        column,
        sqlName,
        proposed: encodeProposedDraftValue(column, value),
        plannedRevision: false,
      },
    ]
  })

  if (intent === 'insert' && target.revisionColumn) {
    fields.push({
      column: target.revisionColumn,
      sqlName: target.revisionColumn.name as string,
      proposed: encodeProposedDraftValue(target.revisionColumn, 1),
      plannedRevision: true,
    })
  }

  return fields
}

function draftBasePredicates(target: DraftRowTarget): SQL[] {
  const predicates: SQL[] = [
    sql`${sql.raw(`${quoteSqlIdentifier(target.pkColumnName)} = `)}${sql.param(target.pkValue)}`,
  ]
  if (target.tenantColumn) {
    predicates.push(
      sql`${sql.raw(`${quoteSqlIdentifier(target.tenantColumn.name)} = `)}${sql.param(
        target.tenantValue,
      )}`,
    )
  }
  return predicates
}

function buildDraftBaseCte(target: DraftRowTarget, draftId: string): SQL {
  const revisionState = target.revisionColumn
    ? sql`${sql.raw(', revision_state AS (SELECT revision FROM wystack_row_revisions WHERE table_key = ')}${sql.param(
        target.tableKey,
      )}${sql.raw(' AND tenant_key_text = ')}${sql.param(target.tenantKey.text)}${sql.raw(
        ' AND row_key_text = ',
      )}${sql.param(target.rowKey.text)}${sql.raw(')')}`
    : sql.empty()
  const existingChange = sql`${sql.raw(
    `, existing_change AS (SELECT "operation" FROM ${draftChangesRelation} WHERE "draft_id" = `,
  )}${sql.param(draftId)}${sql.raw(' AND "table_key" = ')}${sql.param(
    target.tableKey,
  )}${sql.raw(' AND "tenant_key_text" = ')}${sql.param(target.tenantKey.text)}${sql.raw(
    ' AND "row_key_text" = ',
  )}${sql.param(target.rowKey.text)}${sql.raw(' FOR UPDATE)')}`

  return sql`${sql.raw(`WITH base AS (SELECT * FROM ${target.baseRelation} WHERE `)}${sql.join(
    draftBasePredicates(target),
    sql.raw(' AND '),
  )}${sql.raw(' FOR UPDATE)')}${revisionState}${existingChange}${sql.raw(' ')}`
}

function buildFieldsExpression(fields: DraftField[], basePresent: string): SQL {
  const pairs = fields.map(({ column, sqlName, proposed, plannedRevision }) => {
    const kind = ['json', 'jsonb'].includes(draftCastType(column)) ? 'json' : 'value'
    const original =
      `CASE WHEN NOT (${basePresent}) THEN '{"kind":"absent"}'::jsonb ` +
      `WHEN b.${quoteSqlIdentifier(sqlName)} IS NULL THEN '{"kind":"sql-null"}'::jsonb ` +
      `ELSE jsonb_build_object('kind', ${sqlLiteral(kind)}, 'value', to_jsonb(b.${quoteSqlIdentifier(sqlName)})) END`
    const proposedValue = plannedRevision
      ? sql.raw(
          `jsonb_build_object('kind', 'value', 'value', to_jsonb(CASE WHEN ${basePresent} ` +
            `THEN b.${quoteSqlIdentifier(sqlName)} + 1 ` +
            `ELSE COALESCE((SELECT revision FROM revision_state), 0) + 1 END))`,
        )
      : sql`${sql.param(JSON.stringify(proposed))}${sql.raw('::jsonb')}`

    return sql`${sql.raw(`${sqlLiteral(sqlName)}, jsonb_build_object('original', ${original}, 'value', `)}${proposedValue}${sql.raw(
      ')',
    )}`
  })

  return pairs.length
    ? sql`${sql.raw('jsonb_build_object(')}${sql.join(pairs, sql.raw(', '))}${sql.raw(')')}`
    : sql.raw("'{}'::jsonb")
}

function buildDraftChangeValues(
  target: DraftRowTarget,
  draftId: string,
  fields: DraftField[],
  opts: DraftWriteOptions,
): { basePresent: string; values: SQLChunk[] } {
  const basePresent = `b.${quoteSqlIdentifier(target.pkColumnName)} IS NOT NULL`
  const baseRevision = target.revisionColumn
    ? sql.raw(
        `CASE WHEN ${basePresent} THEN to_jsonb(b.${quoteSqlIdentifier(target.revisionColumn.name as string)}) ` +
          `ELSE (SELECT to_jsonb(revision) FROM revision_state) END`,
      )
    : sql.raw('NULL::jsonb')
  const tenantJson = target.tenantColumn
    ? sql`${sql.param(JSON.stringify(target.tenantKey.envelope))}${sql.raw('::jsonb')}`
    : sql.raw('NULL::jsonb')
  const operation = opts.tombstone ? 'delete' : opts.intent
  const fieldsExpression = buildFieldsExpression(fields, basePresent)

  return {
    basePresent,
    values: [
      sql.param(draftId),
      sql.param(target.tableKey),
      sql.param(target.tenantKey.text),
      tenantJson,
      sql.param(target.rowKey.text),
      sql`${sql.param(JSON.stringify(target.rowKey.envelope))}${sql.raw('::jsonb')}`,
      sql.param(operation),
      sql.raw(basePresent),
      baseRevision,
      fieldsExpression,
    ],
  }
}

function buildDraftChangeInsert(
  values: SQLChunk[],
  intent: DraftWriteIntent,
  basePresent: string,
): SQL {
  const insertAvailabilityGuard =
    intent === 'insert'
      ? sql.raw(
          ` WHERE NOT (` +
            `EXISTS (SELECT 1 FROM existing_change WHERE "operation" <> 'delete') ` +
            `OR (NOT EXISTS (SELECT 1 FROM existing_change) AND ${basePresent}))`,
        )
      : sql.empty()

  return sql`${sql.raw(
    `INSERT INTO ${draftChangesRelation} ` +
      `("draft_id", "table_key", "tenant_key_text", "tenant_key", "row_key_text", "row_key", ` +
      `"operation", "base_exists", "base_revision", "fields") SELECT `,
  )}${sql.join(values, sql.raw(', '))}${sql.raw(
    ' FROM (SELECT 1) seed LEFT JOIN base b ON TRUE',
  )}${insertAvailabilityGuard}`
}

function buildDraftChangeReconciliation(intent: DraftWriteIntent): SQL {
  const restoreDeletedRowGuard =
    intent === 'insert'
      ? sql.raw(` WHERE ${draftChangesRelation}."operation" = 'delete'`)
      : sql.empty()

  return sql`${sql.raw(
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
      `), '{}'::jsonb)`,
  )}${restoreDeletedRowGuard}`
}

function buildDraftWriteQuery(
  target: DraftRowTarget,
  draftId: string,
  fields: DraftField[],
  opts: DraftWriteOptions,
): SQL {
  const change = buildDraftChangeValues(target, draftId, fields, opts)
  const insert = buildDraftChangeInsert(change.values, opts.intent, change.basePresent)
  const reconcile = buildDraftChangeReconciliation(opts.intent)

  return sql`${buildDraftBaseCte(target, draftId)}${insert}${sql.raw(' ')}${reconcile}${sql.raw(
    ' RETURNING *',
  )}`
}

/**
 * Stabilize one row selected by a predicate write before that predicate is
 * evaluated again. The lock order matches publish and `writeDraftRow`: durable
 * revision identity, canonical row, then this draft's existing change row.
 */
export async function lockDraftWriteCandidate(
  db: DrizzleDb,
  table: AnyTable,
  draftId: string,
  tenantScope: TenantScope,
  pkValue: unknown,
): Promise<void> {
  const target = resolveDraftRowTarget(table, tenantScope, pkValue)
  if (target.revisionColumn) {
    await lockRowRevision(db, table, tenantScope, { [target.pkProperty]: pkValue })
  }

  await db.execute(
    sql`${sql.raw(`SELECT 1 FROM ${target.baseRelation} WHERE `)}${sql.join(
      draftBasePredicates(target),
      sql.raw(' AND '),
    )}${sql.raw(' FOR UPDATE')}`,
  )
  await db.execute(
    sql`${sql.raw(
      `SELECT 1 FROM ${draftChangesRelation} WHERE "draft_id" = `,
    )}${sql.param(draftId)}${sql.raw(' AND "table_key" = ')}${sql.param(
      target.tableKey,
    )}${sql.raw(' AND "tenant_key_text" = ')}${sql.param(target.tenantKey.text)}${sql.raw(
      ' AND "row_key_text" = ',
    )}${sql.param(target.rowKey.text)}${sql.raw(' FOR UPDATE')}`,
  )
}

export async function writeDraftRow(
  db: DrizzleDb,
  tracker: { tablesWritten: Set<string> },
  table: AnyTable,
  draftId: string,
  tenantScope: TenantScope,
  opts: DraftWriteOptions,
): Promise<Record<string, unknown>[]> {
  const target = resolveDraftRowTarget(table, tenantScope, opts.pkValue)

  // Every revision-aware path takes the ledger row before the canonical row.
  // Publish follows this order too; reversing it here lets a draft write and a
  // publish deadlock while each holds one side of the pair.
  if (target.revisionColumn) {
    await lockRowRevision(db, table, tenantScope, { [target.pkProperty]: opts.pkValue })
  }

  const fields = collectDraftFields(target, opts.values, opts.intent)
  const result = await db.execute(buildDraftWriteQuery(target, draftId, fields, opts))
  const rows = normalizeExecuteRows(result)
  if (opts.intent === 'insert' && rows.length === 0) {
    throw new Error(
      `Draft insert cannot create "${target.tableKey}" row ${JSON.stringify(opts.pkValue)} because it already exists`,
    )
  }
  tracker.tablesWritten.add(draftTableTrackingTag(table, tenantScope, draftId))
  return rows
}

function materializeDraftInsertDefaults(
  columns: DraftColumns,
  supplied: Record<string, unknown>,
  systemProperties: Set<string>,
): Record<string, unknown> {
  const row = withoutUndefined(supplied)
  for (const [property, column] of Object.entries(columns)) {
    if (systemProperties.has(property) || Object.hasOwn(row, property)) continue
    if (column.hasDefault) {
      if (typeof column.defaultFn === 'function') {
        throw new Error(
          `Draft insert default for "${property}" is generated at execution time; resolve it into the command input so publish reuses the same value`,
        )
      }
      if (isSQLWrapper(column.default)) {
        throw new Error(
          `Draft insert default for "${property}" is generated by SQL; resolve it into the command input so publish reuses the same value`,
        )
      }
      if (column.default === undefined) {
        throw new Error(
          `Draft insert default for "${property}" is generated at execution time; resolve it into the command input so publish reuses the same value`,
        )
      }
      row[property] = column.default
      continue
    }
    if (!column.notNull) {
      row[property] = null
      continue
    }
    throw new Error(`Draft insert is missing required property "${property}"`)
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
    values: TrackedInsertValues<T> | TrackedInsertValues<T>[],
  ): Promise<Record<string, unknown>[]> {
    assertDraftWriteScope(this._table, this._tenantScope)
    const rows = Array.isArray(values) ? values : [values]
    const config = getTableConfig(this._table)
    const pkColName = resolvePkColumnName(this._table, config)
    const columns = getTableColumns(this._table) as DraftColumns
    const pkPropKey = Object.keys(columns).find((k) => (columns[k].name as string) === pkColName)

    let committedTracker: DraftDrizzleTracker | undefined
    const out = await this._db.transaction(async (txDb: DrizzleDb) => {
      const txDraft = createDrizzleTracker(txDb, this._tenantScope).withDraft(this._draftId)
      committedTracker = txDraft
      const revision = revisionProperty(this._table)
      const prepared = rows.map((row, index) => {
        const supplied = row as Record<string, unknown>
        assertRevisionInput(this._table, supplied)
        assertJsonNullInputs(this._table, supplied)
        const tenantProperty = tryGetTableCapabilities(this._table)?.tenancy?.property
        const r = materializeDraftInsertDefaults(
          columns,
          supplied,
          new Set([
            pkPropKey ?? pkColName,
            ...(tenantProperty ? [tenantProperty] : []),
            ...(revision ? [revision] : []),
          ]),
        )
        assertTenantInput(this._table, r)
        const pkValue = pkPropKey !== undefined ? r[pkPropKey] : r[pkColName]
        if (pkValue === undefined || pkValue === null) {
          throw new Error(
            `DraftInsertBuilder.insert(): row is missing primary key "${pkPropKey ?? pkColName}". ` +
              `Draft inserts require a client-minted PK so the derived row is addressable.`,
          )
        }
        return { index, pkValue, row: r }
      })
      if (revision) {
        prepared.sort((left, right) =>
          compareRowRevisionRows(this._table, this._tenantScope, left.row, right.row),
        )
      }

      const inserted: Array<Record<string, unknown> | undefined> = new Array(rows.length)
      for (const item of prepared) {
        // Pass the full row as sparse values; writeDraftRow drops the PK column,
        // which is carried separately as the stable row identity.
        await writeDraftRow(txDb, txDraft, this._table, this._draftId, this._tenantScope, {
          pkValue: item.pkValue,
          values: item.row,
          tombstone: false,
          intent: 'insert',
        })
        const effective = await txDraft
          .from(this._table)
          .where({ op: 'eq', column: pkPropKey ?? pkColName, value: item.pkValue })
          .first()
        if (effective) inserted[item.index] = effective
      }
      return inserted.filter((row): row is Record<string, unknown> => row !== undefined)
    })
    if (committedTracker) {
      for (const tag of committedTracker.tablesRead) this._tracker.tablesRead.add(tag)
      for (const tag of committedTracker.tablesWritten) this._tracker.tablesWritten.add(tag)
    }
    return out
  }
}
