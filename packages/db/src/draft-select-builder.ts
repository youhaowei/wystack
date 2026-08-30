import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import type { Query, SQL } from 'drizzle-orm'

/**
 * Which lowering a draft read chose. Every plan returns the same rows; they
 * differ in how much canonical data they scan:
 * - `point`   — a primary-key equality pushed into both sides of the overlay.
 * - `bounded` — a filtered or limited read that scans only the canonical
 *               top L + M candidates (M = this draft's changes to the table).
 * - `overlay` — the exact full outer join over the whole canonical table.
 */
export type DraftReadPlan = 'point' | 'bounded' | 'overlay'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { ComparisonFilterDescriptor, FilterDescriptor } from './operators'
import type {
  AnyTable,
  DraftDrizzleTracker,
  DrizzleDb,
  ReadClauses,
  TenantScope,
  TrackedUpdateValues,
} from './tracker-core'
import {
  assertDraftWriteScope,
  assertJsonNullInputs,
  assertNoReadClauses,
  assertRevisionInput,
  assertSoftDeleteInput,
  assertTenantInput,
  assertValidSoftDeleteTimestamp,
  draftChangesRelation,
  draftFieldValueSql,
  draftTableTrackingTag,
  emptyClauses,
  encodeTypedKey,
  noTenantScope,
  quoteSqlIdentifier,
  requireColumn,
  requireSoftDeleteProperty,
  requireTenantScope,
  revisionProperty,
  softDeleteProperty,
  sqlLiteral,
  tableTrackingTag,
  typedKeyValueSql,
  withoutUndefined,
} from './tracker-core'
import { createDrizzleTracker } from './tracker-factory'
import {
  decodeRowFromDriver,
  mapColumnValue,
  normalizeExecuteRows,
  resolvePkColumnName,
} from './tracker-codecs'
import { lockDraftWriteCandidate, writeDraftRow } from './draft-mutations'
import { compareRowRevisionRows } from './row-revisions'
import type { TableSelectedRow } from './table'

const draftSqlOperators = {
  eq: '=',
  ne: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
} as const

/**
 * Lower a predicate against either effective draft expressions or canonical
 * candidate columns. Keeping both paths on this one recursive lowering is what
 * makes candidate pruning and the final overlay agree for nested predicates.
 */
function lowerPredicate(
  filter: FilterDescriptor,
  // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle columns
  columns: Record<string, any>,
  // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle columns
  expression: (column: any) => string,
): SQL {
  if ('filters' in filter) {
    if (filter.filters.length === 0) {
      throw new Error(`${filter.op}() requires at least one predicate`)
    }
    const children = filter.filters.map((child) => lowerPredicate(child, columns, expression))
    const separator = filter.op === 'and' ? ' AND ' : ' OR '
    return sql`${sql.raw('(')}${sql.join(children, sql.raw(separator))}${sql.raw(')')}`
  }

  const column = requireColumn(columns, filter.column)
  const columnSql = expression(column)
  if (!('value' in filter) && !('values' in filter)) {
    return sql.raw(`(${columnSql} ${filter.op === 'isNull' ? 'IS NULL' : 'IS NOT NULL'})`)
  }
  if ('values' in filter) {
    if (filter.values.length === 0) {
      return sql.raw(filter.op === 'in' ? '(FALSE)' : '(TRUE)')
    }
    const values = filter.values.map((value) => sql.param(mapColumnValue(column, value)))
    return sql`${sql.raw(
      `(${columnSql} ${filter.op === 'in' ? 'IN' : 'NOT IN'} (`,
    )}${sql.join(values, sql.raw(', '))}${sql.raw('))')}`
  }
  return sql`${sql.raw(`(${columnSql} ${draftSqlOperators[filter.op]} `)}${sql.param(
    mapColumnValue(column, filter.value),
  )}${sql.raw(')')}`
}

export class DraftSelectBuilder<T extends AnyTable, TRow = TableSelectedRow<T>> {
  private _table: T
  private _db: DrizzleDb
  private _draftId: string
  private _tracker: DraftDrizzleTracker
  private _tenantScope: TenantScope
  // `_clauses.filters` accumulates `where()` predicates against effective rows;
  // the consuming terminal decides whether to read, update, or tombstone them.
  private _clauses: ReadClauses

  constructor(
    table: T,
    db: DrizzleDb,
    draftId: string,
    tracker: DraftDrizzleTracker,
    tenantScope: TenantScope = noTenantScope,
    clauses: ReadClauses = emptyClauses(),
  ) {
    this._table = table
    this._db = db
    this._draftId = draftId
    this._tracker = tracker
    this._tenantScope = tenantScope
    this._clauses = clauses
  }

  /** Copy carrying `patch`. See `SelectBuilder._with` for why no clause method
   *  assigns to `this`. */
  private _with<TNext = TRow>(patch: Partial<ReadClauses>): DraftSelectBuilder<T, TNext> {
    return new DraftSelectBuilder<T, TNext>(
      this._table,
      this._db,
      this._draftId,
      this._tracker,
      this._tenantScope,
      {
        ...this._clauses,
        ...patch,
      },
    )
  }

  /** Project effective rows by the same property-key contract as canonical reads. */
  select<K extends keyof TableSelectedRow<T> & string>(
    ...cols: [K, ...K[]]
  ): DraftSelectBuilder<T, Pick<TableSelectedRow<T>, K>> {
    if (cols.length === 0) throw new Error('select() requires at least one column')
    return this._with<Pick<TableSelectedRow<T>, K>>({ projection: cols })
  }

  where(filters: FilterDescriptor | FilterDescriptor[]): DraftSelectBuilder<T, TRow> {
    const toAdd = Array.isArray(filters) ? filters : [filters]
    return this._with({ filters: [...this._clauses.filters, ...toAdd] })
  }

  /** Include both active and soft-deleted effective rows in this builder's scope. */
  includeDeleted(): DraftSelectBuilder<T, TRow> {
    requireSoftDeleteProperty(this._table)
    return this._with({ softDeleteScope: 'include' })
  }

  /** Restrict this builder to soft-deleted effective rows. */
  onlyDeleted(): DraftSelectBuilder<T, TRow> {
    requireSoftDeleteProperty(this._table)
    return this._with({ softDeleteScope: 'only' })
  }

  /**
   * Order the coalesced read by `col` (a property key, as everywhere else).
   *
   * The ordering expression is `COALESCE(d."col", b."col")`, not `b."col"`: a
   * draft-INSERTED row has no base side, so `b."col"` is NULL there and the row
   * would sort as NULL no matter what the draft actually holds. Ordering must
   * see the same value the SELECT list returns.
   *
   * The primary key stays on as a trailing tiebreaker, matching the canonical
   * builder. The coalesce is a FULL OUTER JOIN, whose row order is unspecified,
   * so without it two rows equal on `col` could come back in a different order
   * run to run — and differently from the canonical read of the same table.
   */
  orderBy(col: string, dir: 'asc' | 'desc' = 'asc'): DraftSelectBuilder<T, TRow> {
    if (col === '') throw new Error('orderBy() requires a column name')
    return this._with({ orderByCol: col, orderDir: dir })
  }

  /**
   * Cap the coalesced read at `n` rows. Safe to compose because the ORDER BY
   * above always ends in the primary key, so the capped set is a well-defined
   * prefix rather than an arbitrary sample of the join output.
   */
  limit(n: number): DraftSelectBuilder<T, TRow> {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`limit() requires a non-negative integer — got ${n}`)
    }
    return this._with({ limitVal: n })
  }

  /**
   * Match PostgreSQL's conditional write behavior across our two-statement
   * lowering: identify candidates, lock them in a stable order, then evaluate
   * the predicate again against the locked effective rows. A canonical update
   * that wins before the lock therefore moves the row out of the draft write
   * instead of silently changing the anchor underneath the original match.
   */
  private async _lockedWriteMatches(
    txDb: DrizzleDb,
    txDraft: DraftDrizzleTracker,
    pkProperty: string,
  ): Promise<Record<string, unknown>[]> {
    const scope = <TRowValue>(builder: DraftSelectBuilder<T, TRowValue>) => {
      if (this._clauses.softDeleteScope === 'include') return builder.includeDeleted()
      if (this._clauses.softDeleteScope === 'only') return builder.onlyDeleted()
      return builder
    }
    const candidates = (await scope(txDraft.from(this._table))
      .where(this._clauses.filters)
      .all()) as Record<string, unknown>[]
    candidates.sort((left, right) =>
      compareRowRevisionRows(this._table, this._tenantScope, left, right),
    )

    for (const candidate of candidates) {
      await lockDraftWriteCandidate(
        txDb,
        this._table,
        this._draftId,
        this._tenantScope,
        candidate[pkProperty],
      )
    }

    const lockedMatches: Record<string, unknown>[] = []
    for (const candidate of candidates) {
      const match = await scope(txDraft.from(this._table))
        .where([
          ...this._clauses.filters,
          { op: 'eq', column: pkProperty, value: candidate[pkProperty] },
        ])
        .first()
      if (match) lockedMatches.push(match as Record<string, unknown>)
    }
    return lockedMatches
  }

  /**
   * Sparse cell-edit: upsert one central change row and merge ONLY the fields
   * present in `values`, so a draft update of one field does not clobber another.
   * Mirrors the canonical
   * `from(t).where(eq('id', x)).update(vals)` shape a command handler emits, but
   * the write lands in `wystack_draft_row_changes`, not the canonical table.
   *
   * Filters have full effective-row parity with canonical updates: every row
   * matched by the composed predicate receives the sparse patch. Returns the
   * resulting effective rows. Read-only select/order/limit clauses are rejected
   * because a write cannot honor their return-shaping semantics.
   */
  async update(values: TrackedUpdateValues<T>): Promise<TableSelectedRow<T>[]> {
    return this._update(values, false)
  }

  private async _update(
    values: TrackedUpdateValues<T>,
    allowSoftDeleteInput: boolean,
  ): Promise<TableSelectedRow<T>[]> {
    assertNoReadClauses('update', this._clauses)
    assertDraftWriteScope(this._table, this._tenantScope)
    const patch = withoutUndefined(values as Record<string, unknown>)
    assertTenantInput(this._table, patch)
    assertRevisionInput(this._table, patch)
    if (!allowSoftDeleteInput) assertSoftDeleteInput(this._table, patch)
    if (Object.keys(patch).length === 0) return []
    assertJsonNullInputs(this._table, patch)

    const columns = getTableColumns(this._table) as Record<string, { name: string }>
    const pkSqlName = resolvePkColumnName(this._table, getTableConfig(this._table))
    const pkProperty = Object.keys(columns).find((property) => columns[property].name === pkSqlName)
    if (!pkProperty)
      throw new Error(`Cannot resolve primary-key property for "${getTableName(this._table)}"`)
    if (Object.hasOwn(patch, pkProperty) || Object.hasOwn(patch, pkSqlName)) {
      throw new Error(`Primary key "${pkProperty}" is immutable in a draft update`)
    }

    let committedTracker: DraftDrizzleTracker | undefined
    const rows = await this._db.transaction(async (txDb: DrizzleDb) => {
      const txDraft = createDrizzleTracker(txDb, this._tenantScope).withDraft(this._draftId)
      committedTracker = txDraft
      const matches = await this._lockedWriteMatches(txDb, txDraft, pkProperty)
      const updated: Record<string, unknown>[] = []
      for (const match of matches) {
        const pkValue = match[pkProperty]
        const revision = revisionProperty(this._table)
        const valuesWithRevision = revision
          ? { ...patch, [revision]: Number(match[revision]) + 1 }
          : patch
        await writeDraftRow(txDb, txDraft, this._table, this._draftId, this._tenantScope, {
          pkValue,
          values: valuesWithRevision,
          tombstone: false,
          intent: 'update',
        })
        const effectiveBuilder = txDraft.from(this._table)
        const effective = await (
          softDeleteProperty(this._table) ? effectiveBuilder.includeDeleted() : effectiveBuilder
        )
          .where({ op: 'eq', column: pkProperty, value: pkValue })
          .first()
        if (effective) updated.push(effective)
      }
      return updated
    })
    if (committedTracker) {
      for (const tag of committedTracker.tablesRead) this._tracker.tablesRead.add(tag)
      for (const tag of committedTracker.tablesWritten) this._tracker.tablesWritten.add(tag)
    }
    return rows
  }

  /** Record a deterministic tombstone update in derived storage. */
  async softDelete(at: Date): Promise<TableSelectedRow<T>[]> {
    const property = requireSoftDeleteProperty(this._table)
    assertValidSoftDeleteTimestamp(at)
    return this._update({ [property]: new Date(at.getTime()) } as TrackedUpdateValues<T>, true)
  }

  /** Record a deterministic tombstone clear in derived storage. */
  async restore(): Promise<TableSelectedRow<T>[]> {
    const property = requireSoftDeleteProperty(this._table)
    const scoped = this._with({ softDeleteScope: 'only' })
    return scoped._update({ [property]: null } as TrackedUpdateValues<T>, true)
  }

  /**
   * Record a delete operation in the central draft relation.
   * so the coalesce read suppresses it. Mirrors the canonical
   * `from(t).where(eq('id', x)).delete()` a command handler emits.
   *
   * Filters have full effective-row parity with canonical deletes; every match
   * receives a delete marker in derived storage.
   */
  async delete(): Promise<TableSelectedRow<T>[]> {
    if (softDeleteProperty(this._table)) {
      throw new Error(
        `Table "${getTableName(this._table)}" uses soft deletion; physical delete() is unavailable. Use softDelete(at).`,
      )
    }
    assertNoReadClauses('delete', this._clauses)
    assertDraftWriteScope(this._table, this._tenantScope)
    const columns = getTableColumns(this._table) as Record<string, { name: string }>
    const pkSqlName = resolvePkColumnName(this._table, getTableConfig(this._table))
    const pkProperty = Object.keys(columns).find((property) => columns[property].name === pkSqlName)
    if (!pkProperty)
      throw new Error(`Cannot resolve primary-key property for "${getTableName(this._table)}"`)

    let committedTracker: DraftDrizzleTracker | undefined
    const rows = await this._db.transaction(async (txDb: DrizzleDb) => {
      const txDraft = createDrizzleTracker(txDb, this._tenantScope).withDraft(this._draftId)
      committedTracker = txDraft
      const matches = await this._lockedWriteMatches(txDb, txDraft, pkProperty)
      for (const match of matches) {
        await writeDraftRow(txDb, txDraft, this._table, this._draftId, this._tenantScope, {
          pkValue: match[pkProperty],
          // Preserve a full first-touch anchor for deletes. Revisioned tables
          // already have row-level CAS; non-revisioned tables need the field
          // originals so publish can detect a changed row before deleting it.
          values: match,
          tombstone: true,
          intent: 'delete',
        })
      }
      return matches
    })
    if (committedTracker) {
      for (const tag of committedTracker.tablesRead) this._tracker.tablesRead.add(tag)
      for (const tag of committedTracker.tablesWritten) this._tracker.tablesWritten.add(tag)
    }
    return rows
  }

  async all(): Promise<TRow[]> {
    return this._coalescedRead()
  }

  /**
   * The coalesce itself. `limitOverride` exists so `first()` can lower `LIMIT 1`
   * without setting `_clauses.limitVal` — see `first()` for why that field must
   * mean only "the caller attached `limit()`".
   */
  private async _coalescedRead(limitOverride?: number): Promise<TRow[]> {
    // Record the base table read AND its virtual per-table draft tag. The rows
    // physically share one central relation, but invalidation remains scoped by
    // logical table/tenant/draft so unrelated drafts do not refetch.
    this._tracker.tablesRead.add(tableTrackingTag(this._table, this._tenantScope))
    this._tracker.tablesRead.add(
      draftTableTrackingTag(this._table, this._tenantScope, this._draftId),
    )

    const { query, colEntries } = this._buildCoalesceQuery(limitOverride)
    const result = await this._db.execute(query)
    const rows = normalizeExecuteRows(result)

    // Decode each returned column value through its Drizzle column codec — the
    // READ mirror of the write path's `mapColumnValue` (encode). The coalesce
    // SELECT aliases every column to its Drizzle PROPERTY KEY (`AS "propKey"`),
    // so `colEntries` (propKey → col) is exactly the map to decode by. Without
    // this, a non-identity column type (jsonb, timestamp, …) comes back in its
    // RAW driver representation on the production driver:
    //   - PGlite auto-parses jsonb → JS object, so the integration tests pass
    //     even without decode (the bug is invisible to them).
    //   - postgres-js (the `createDb` production driver) returns a jsonb column
    //     as a raw JSON STRING. A draft-context read of `insights.definition`
    //     then hands a string to consumers expecting an object, which silently
    //     misbehave (`.source` on a string) or throw.
    // The column's own `mapFromDriverValue` is driver-independent: jsonb's is
    // guarded with `typeof value === 'string'`, so it JSON.parses the
    // postgres-js string AND is a no-op on the already-parsed PGlite object — no
    // double-parse. Columns not in the schema are left untouched.
    return rows.map((row) => decodeRowFromDriver(row, colEntries) as TRow)
  }

  /**
   * Return the lowered coalesce SQL without executing — the draft twin of
   * `SelectBuilder.toSql()`, and the seam that lets a test assert what this
   * builder *emits* rather than what PGlite happens to return.
   *
   * That distinction is load-bearing, not stylistic. Draft rows come back from a
   * FULL OUTER JOIN over a heap populated in primary-key order, so PGlite emits
   * PK order whether or not an `ORDER BY` was lowered — a returned-row assertion
   * passes with the clause deleted. The clause is only observable here.
   *
   * Like the canonical `toSql()`, this skips the `tablesRead` side-effect: it
   * lowers a query, it does not perform a read. `limitOverride` mirrors
   * `first()`'s `LIMIT 1` pushdown for the same reason it does there.
   */
  toSql(limitOverride?: number): Query & { plan: DraftReadPlan } {
    // The coalesce is a raw `sql` template, not a Drizzle query builder, so it
    // has no `.toSQL()` of its own — the dialect lowers it instead. Same
    // parameter binding either way; only the entry point differs.
    const lowered = this._buildCoalesceQuery(limitOverride)
    return { ...this._db.dialect.sqlToQuery(lowered.query), plan: lowered.plan }
  }

  /**
   * Build the coalesce query and the column map its result must be decoded by.
   * Single source of truth shared by `_coalescedRead()` and `toSql()`, so the
   * SQL a test asserts is the SQL a read executes. `plan` names which lowering
   * was chosen — the one fact about the SQL that result parity cannot observe.
   */
  private _buildCoalesceQuery(limitOverride?: number): {
    query: SQL
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    colEntries: [string, any][]
    plan: DraftReadPlan
  } {
    const tableName = getTableName(this._table)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const colEntries = Object.entries(columns)
    const config = getTableConfig(this._table)
    const pkColName = resolvePkColumnName(this._table, config)
    const pkEntry = colEntries.find(([, column]) => column.name === pkColName)
    if (!pkEntry) throw new Error(`Cannot resolve primary key property for "${tableName}"`)
    const [pkProperty, pkColumn] = pkEntry
    const tenant = requireTenantScope(this._table, this._tenantScope)
    const schema = config.schema
    const tableKey = schema ? `${schema}.${tableName}` : tableName
    const baseRel = schema
      ? `${quoteSqlIdentifier(schema)}.${quoteSqlIdentifier(tableName)}`
      : quoteSqlIdentifier(tableName)
    const tenantColumn = tenant ? requireColumn(columns, tenant.tenancy.property) : undefined
    const tenantKey = tenantColumn
      ? encodeTypedKey(tenantColumn, tenant!.tenantId)
      : { envelope: null, text: '' }

    const keyFromChange = typedKeyValueSql('d', 'row_key', pkColumn)
    // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle columns
    const effectiveExpression = (column: any) => {
      const sqlName = column.name as string
      if (sqlName === pkColName)
        return `COALESCE(${keyFromChange}, b.${quoteSqlIdentifier(sqlName)})`
      if (tenantColumn && sqlName === tenantColumn.name) {
        const tenantFromChange = typedKeyValueSql('d', 'tenant_key', tenantColumn)
        return `COALESCE(${tenantFromChange}, b.${quoteSqlIdentifier(sqlName)})`
      }
      return (
        `CASE WHEN d."fields" ? ${sqlLiteral(sqlName)} ` +
        `THEN ${draftFieldValueSql(column, 'd')} ELSE b.${quoteSqlIdentifier(sqlName)} END`
      )
    }

    const selectedEntries = this._clauses.projection
      ? this._clauses.projection.map(
          (propKey) => [propKey, requireColumn(columns, propKey)] as const,
        )
      : colEntries
    const colSelects = selectedEntries
      .map(([propKey, col]) => {
        return `${effectiveExpression(col)} AS ${quoteSqlIdentifier(propKey)}`
      })
      .join(', ')

    // A PK equality is pushed into BOTH sides. The canonical side retains its
    // native PK index; the small side hits the central composite key instead of
    // scanning the entire draft and filtering a COALESCE after the join.
    const pkFilter = this._clauses.filters.find(
      (filter): filter is ComparisonFilterDescriptor =>
        filter.op === 'eq' && 'column' in filter && filter.column === pkProperty,
    )
    const pointKey = pkFilter ? encodeTypedKey(pkColumn, pkFilter.value) : undefined

    const basePredicates: SQL[] = []
    if (tenant && tenantColumn) {
      basePredicates.push(
        sql`${sql.raw(`${quoteSqlIdentifier(tenantColumn.name)} = `)}${sql.param(mapColumnValue(tenantColumn, tenant.tenantId))}`,
      )
    }
    if (pkFilter) {
      basePredicates.push(
        sql`${sql.raw(`${quoteSqlIdentifier(pkColName)} = `)}${sql.param(mapColumnValue(pkColumn, pkFilter.value))}`,
      )
    }
    const baseWhere = basePredicates.length
      ? sql`${sql.raw(' WHERE ')}${sql.join(basePredicates, sql.raw(' AND '))}`
      : sql.raw('')

    const changePoint = pointKey
      ? sql`${sql.raw(' AND "row_key_text" = ')}${sql.param(pointKey.text)}`
      : sql.raw('')
    const prefix = sql.raw(`SELECT ${colSelects} FROM (SELECT * FROM ${baseRel}`)
    const change = sql`${sql.raw(
      `) b FULL OUTER JOIN (SELECT * FROM ${draftChangesRelation} WHERE "draft_id" = `,
    )}${sql.param(this._draftId)}${sql.raw(' AND "table_key" = ')}${sql.param(tableKey)}${sql.raw(
      ' AND "tenant_key_text" = ',
    )}${sql.param(tenantKey.text)}${changePoint}${sql.raw(
      `) d ON b.${quoteSqlIdentifier(pkColName)} = ${keyFromChange} WHERE COALESCE(d."operation", 'update') <> 'delete'`,
    )}`

    const pkOrder = effectiveExpression(pkColumn)
    let orderByClause = ` ORDER BY ${pkOrder}`
    if (this._clauses.orderByCol !== undefined) {
      const col = requireColumn(columns, this._clauses.orderByCol)
      const dir = this._clauses.orderDir === 'desc' ? ' DESC' : ''
      orderByClause = ` ORDER BY ${effectiveExpression(col)}${dir}, ${pkOrder}`
    }
    const orderBy = sql.raw(orderByClause)
    // Same rule as the canonical builder: `first()` narrows, it never widens a
    // caller-attached limit, so `limit(0).first()` stays null.
    const limitVal =
      limitOverride === undefined
        ? this._clauses.limitVal
        : Math.min(limitOverride, this._clauses.limitVal ?? limitOverride)
    const limit = limitVal === undefined ? sql.raw('') : sql`${sql.raw(' LIMIT ')}${limitVal}`
    const effectiveFilters = this._clauses.filters.map((filter) =>
      lowerPredicate(filter, columns, effectiveExpression),
    )
    const deletedProperty = softDeleteProperty(this._table)
    if (deletedProperty && this._clauses.softDeleteScope !== 'include') {
      const deletedColumn = requireColumn(columns, deletedProperty)
      effectiveFilters.unshift(
        sql.raw(
          `(${effectiveExpression(deletedColumn)} IS ${this._clauses.softDeleteScope === 'only' ? 'NOT ' : ''}NULL)`,
        ),
      )
    }
    const filterPredicate = effectiveFilters.length
      ? sql`${sql.raw(' AND ')}${sql.join(effectiveFilters, sql.raw(' AND '))}`
      : sql.raw('')

    // A filtered effective query can start from canonical matches; a limited
    // one can reduce those matches further. If this table has M draft changes,
    // at most M rows can enter, leave, move, or disappear relative to the base
    // ordering. Therefore an unchanged base row below the canonical top L + M
    // cannot reach the effective top L.
    //
    // Keep every comparison in PostgreSQL: the bounded plan reduces the base
    // candidate set, then applies the SAME effective expressions, filters,
    // ordering, and limit as the generic full-join plan. JavaScript never has
    // to emulate SQL NULL, collation, timestamp, or JSONB semantics.
    //
    // PK equality already has a tighter two-sided index pushdown above, so it
    // stays on the simpler generic shape.
    if ((limitVal !== undefined || this._clauses.filters.length > 0) && !pkFilter) {
      const candidatePredicates: SQL[] = []
      if (tenant && tenantColumn) {
        candidatePredicates.push(
          sql`${sql.raw(`c.${quoteSqlIdentifier(tenantColumn.name)} = `)}${sql.param(mapColumnValue(tenantColumn, tenant.tenantId))}`,
        )
      }
      if (deletedProperty && this._clauses.softDeleteScope !== 'include') {
        const deletedColumn = requireColumn(columns, deletedProperty)
        candidatePredicates.push(
          sql.raw(
            `(c.${quoteSqlIdentifier(deletedColumn.name as string)} IS ${this._clauses.softDeleteScope === 'only' ? 'NOT ' : ''}NULL)`,
          ),
        )
      }
      for (const filter of this._clauses.filters) {
        candidatePredicates.push(
          lowerPredicate(
            filter,
            columns,
            (column) => `c.${quoteSqlIdentifier(column.name as string)}`,
          ),
        )
      }
      const candidateWhere = candidatePredicates.length
        ? sql`${sql.raw(' WHERE ')}${sql.join(candidatePredicates, sql.raw(' AND '))}`
        : sql.raw('')

      const cteKeyFromChange = typedKeyValueSql('dc', 'row_key', pkColumn)
      const changedBaseTenantJoin =
        tenant && tenantColumn
          ? sql`${sql.raw(` AND c.${quoteSqlIdentifier(tenantColumn.name)} = `)}${sql.param(mapColumnValue(tenantColumn, tenant.tenantId))}`
          : sql.raw('')

      let candidateBound = sql.raw('')
      if (limitVal !== undefined) {
        const candidateOrderColumn = this._clauses.orderByCol
          ? requireColumn(columns, this._clauses.orderByCol)
          : pkColumn
        const candidateDirection =
          this._clauses.orderByCol && this._clauses.orderDir === 'desc' ? ' DESC' : ''
        const candidateOrder =
          candidateOrderColumn.name === pkColName
            ? `c.${quoteSqlIdentifier(pkColName)}${candidateDirection}`
            : `c.${quoteSqlIdentifier(candidateOrderColumn.name)}${candidateDirection}, c.${quoteSqlIdentifier(pkColName)}`
        candidateBound = sql`${sql.raw(` ORDER BY ${candidateOrder} LIMIT (`)}${sql.param(
          limitVal,
        )}${sql.raw(' + (SELECT COUNT(*) FROM draft_delta))')}`
      }

      const boundedQuery = sql`${sql.raw('WITH draft_delta AS (SELECT * FROM ')}${sql.raw(
        draftChangesRelation,
      )}${sql.raw(' WHERE "draft_id" = ')}${sql.param(this._draftId)}${sql.raw(
        ' AND "table_key" = ',
      )}${sql.param(tableKey)}${sql.raw(' AND "tenant_key_text" = ')}${sql.param(
        tenantKey.text,
      )}${sql.raw('), base_top AS (SELECT c.* FROM ')}${sql.raw(baseRel)}${sql.raw(
        ' c',
      )}${candidateWhere}${candidateBound}${sql.raw(
        '), candidate_base AS (SELECT bt.* FROM base_top bt WHERE NOT EXISTS (SELECT 1 FROM draft_delta dc WHERE bt.',
      )}${sql.raw(
        quoteSqlIdentifier(pkColName),
      )}${sql.raw(` = ${cteKeyFromChange}) UNION ALL SELECT c.* FROM draft_delta dc JOIN `)}${sql.raw(
        baseRel,
      )}${sql.raw(` c ON c.${quoteSqlIdentifier(pkColName)} = ${cteKeyFromChange}`)}${changedBaseTenantJoin}${sql.raw(
        `) SELECT ${colSelects} FROM candidate_base b FULL OUTER JOIN draft_delta d ON b.${quoteSqlIdentifier(pkColName)} = ${keyFromChange} WHERE COALESCE(d."operation", 'update') <> 'delete'`,
      )}${filterPredicate}${orderBy}${limit}`

      return { query: boundedQuery, colEntries, plan: 'bounded' }
    }

    const query = sql`${prefix}${baseWhere}${change}${filterPredicate}${orderBy}${limit}`

    return { query, colEntries, plan: pkFilter ? 'point' : 'overlay' }
  }

  /**
   * Mirrors canonical `first()` through the same effective-row filter lowering.
   * `LIMIT 1` is an override, not `_clauses.limitVal`, because the write guard
   * reserves that field for a limit explicitly attached by the caller.
   */
  async first(): Promise<TRow | null> {
    const rows = await this._coalescedRead(1)
    return rows[0] ?? null
  }
}
