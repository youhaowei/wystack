import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import type { Query, SQL } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { FilterDescriptor } from './operators'
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
  assertNoReadClauses,
  assertRevisionInput,
  assertTenantInput,
  draftChangesRelation,
  draftFieldValueSql,
  draftTableTrackingTag,
  emptyClauses,
  encodeTypedKey,
  noTenantScope,
  quoteSqlIdentifier,
  requireColumn,
  requireTenantScope,
  revisionProperty,
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
import { writeDraftRow } from './draft-mutations'

export class DraftSelectBuilder<T extends AnyTable> {
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
  private _with(patch: Partial<ReadClauses>): DraftSelectBuilder<T> {
    return new DraftSelectBuilder<T>(
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
  select<K extends keyof T['$inferSelect'] & string>(...cols: [K, ...K[]]): DraftSelectBuilder<T> {
    if (cols.length === 0) throw new Error('select() requires at least one column')
    return this._with({ projection: cols })
  }

  where(filters: FilterDescriptor | FilterDescriptor[]): DraftSelectBuilder<T> {
    const toAdd = Array.isArray(filters) ? filters : [filters]
    return this._with({ filters: [...this._clauses.filters, ...toAdd] })
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
  orderBy(col: string, dir: 'asc' | 'desc' = 'asc'): DraftSelectBuilder<T> {
    if (col === '') throw new Error('orderBy() requires a column name')
    return this._with({ orderByCol: col, orderDir: dir })
  }

  /**
   * Cap the coalesced read at `n` rows. Safe to compose because the ORDER BY
   * above always ends in the primary key, so the capped set is a well-defined
   * prefix rather than an arbitrary sample of the join output.
   */
  limit(n: number): DraftSelectBuilder<T> {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`limit() requires a non-negative integer — got ${n}`)
    }
    return this._with({ limitVal: n })
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
  async update(values: TrackedUpdateValues<T>): Promise<Record<string, unknown>[]> {
    assertNoReadClauses('update', this._clauses)
    assertDraftWriteScope(this._table, this._tenantScope)
    const patch = withoutUndefined(values as Record<string, unknown>)
    assertTenantInput(this._table, patch)
    assertRevisionInput(this._table, patch)
    if (Object.keys(patch).length === 0) return []

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
      const matches = await txDraft.from(this._table).where(this._clauses.filters).all()
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
        const effective = await txDraft
          .from(this._table)
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

  /**
   * Record a delete operation in the central draft relation.
   * so the coalesce read suppresses it. Mirrors the canonical
   * `from(t).where(eq('id', x)).delete()` a command handler emits.
   *
   * Filters have full effective-row parity with canonical deletes; every match
   * receives a delete marker in derived storage.
   */
  async delete(): Promise<Record<string, unknown>[]> {
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
      const matches = await txDraft.from(this._table).where(this._clauses.filters).all()
      for (const match of matches) {
        await writeDraftRow(txDb, txDraft, this._table, this._draftId, this._tenantScope, {
          pkValue: match[pkProperty],
          values: {},
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

  async all(): Promise<Record<string, unknown>[]> {
    return this._coalescedRead()
  }

  /**
   * The coalesce itself. `limitOverride` exists so `first()` can lower `LIMIT 1`
   * without setting `_clauses.limitVal` — see `first()` for why that field must
   * mean only "the caller attached `limit()`".
   */
  private async _coalescedRead(limitOverride?: number): Promise<Record<string, unknown>[]> {
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
    return rows.map((row) => decodeRowFromDriver(row, colEntries))
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
  toSql(limitOverride?: number): Query {
    // The coalesce is a raw `sql` template, not a Drizzle query builder, so it
    // has no `.toSQL()` of its own — the dialect lowers it instead. Same
    // parameter binding either way; only the entry point differs.
    return this._db.dialect.sqlToQuery(this._buildCoalesceQuery(limitOverride).query)
  }

  /**
   * Build the coalesce query and the column map its result must be decoded by.
   * Single source of truth shared by `_coalescedRead()` and `toSql()`, so the
   * SQL a test asserts is the SQL a read executes.
   */
  private _buildCoalesceQuery(limitOverride?: number): {
    query: SQL
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    colEntries: [string, any][]
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
      (filter) => filter.op === 'eq' && filter.column === pkProperty,
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
    const limitVal = limitOverride ?? this._clauses.limitVal
    const limit = limitVal === undefined ? sql.raw('') : sql`${sql.raw(' LIMIT ')}${limitVal}`
    const sqlOperators = {
      eq: '=',
      ne: '<>',
      gt: '>',
      gte: '>=',
      lt: '<',
      lte: '<=',
    } as const
    const filterFragments = this._clauses.filters.map((filter) => {
      const column = requireColumn(columns, filter.column)
      return sql`${sql.raw(
        ` AND ${effectiveExpression(column)} ${sqlOperators[filter.op]} `,
      )}${sql.param(mapColumnValue(column, filter.value))}`
    })
    const filterPredicate = sql.join(filterFragments, sql.raw(''))

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
      for (const filter of this._clauses.filters) {
        const column = requireColumn(columns, filter.column)
        candidatePredicates.push(
          sql`${sql.raw(
            `c.${quoteSqlIdentifier(column.name)} ${sqlOperators[filter.op]} `,
          )}${sql.param(mapColumnValue(column, filter.value))}`,
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

      return { query: boundedQuery, colEntries }
    }

    const query = sql`${prefix}${baseWhere}${change}${filterPredicate}${orderBy}${limit}`

    return { query, colEntries }
  }

  /**
   * Mirrors canonical `first()` through the same effective-row filter lowering.
   * `LIMIT 1` is an override, not `_clauses.limitVal`, because the write guard
   * reserves that field for a limit explicitly attached by the caller.
   */
  async first(): Promise<Record<string, unknown> | null> {
    const rows = await this._coalescedRead(1)
    return rows[0] ?? null
  }
}
