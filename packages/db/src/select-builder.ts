import { and, asc, desc, eq as drizzleEq, getTableColumns, sql } from 'drizzle-orm'
import type { Query } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { FilterDescriptor } from './operators'
import type {
  AnyTable,
  DrizzleDb,
  DrizzleTracker,
  LoweredSelect,
  ReadClauses,
  TenantScope,
} from './tracker-core'
import {
  assertNoReadClauses,
  assertRevisionInput,
  assertTenantInput,
  drizzleOpMap,
  emptyClauses,
  noTenantScope,
  requireColumn,
  requireTenantScope,
  revisionProperty,
  tableTrackingTag,
  withoutUndefined,
} from './tracker-core'
import { resolvePkColumnName } from './tracker-codecs'
import { lockRowRevision, preserveRowRevision, rowRevisionSortKey } from './row-revisions'

export class SelectBuilder<T extends AnyTable, TRow = T['$inferSelect']> {
  private _table: T
  private _db: DrizzleDb
  private _tracker: DrizzleTracker
  private _tenantScope: TenantScope
  private _clauses: ReadClauses
  private _writeError?: string

  constructor(
    table: T,
    db: DrizzleDb,
    tracker: DrizzleTracker,
    tenantScope: TenantScope = noTenantScope,
    clauses: ReadClauses = emptyClauses(),
    writeError?: string,
  ) {
    this._table = table
    this._db = db
    this._tracker = tracker
    this._tenantScope = tenantScope
    this._clauses = clauses
    this._writeError = writeError
  }

  /**
   * Return a COPY carrying `patch` on top of this builder's clauses. Every clause
   * method goes through here; none assigns to `this`.
   *
   * A builder that mutated itself and returned itself handed out two names for
   * one query, and three separate bugs followed from that one fact: a projection
   * applied through one name silently changed what the other yielded (while
   * `select()`'s re-typed return made the type disagree with the object), and a
   * read clause consumed by a finished read stayed attached to reject a later
   * write. Copying makes the builder a value, so there is nothing to alias.
   *
   * `TNext` lets `select()` narrow the row type on the copy while every other
   * clause keeps `TRow`.
   */
  private _with<TNext = TRow>(patch: Partial<ReadClauses>): SelectBuilder<T, TNext> {
    return new SelectBuilder<T, TNext>(
      this._table,
      this._db,
      this._tracker,
      this._tenantScope,
      {
        ...this._clauses,
        ...patch,
      },
      this._writeError,
    )
  }

  /**
   * Narrow the read to `cols`. Column names are the table's JS property keys
   * (same vocabulary as `where`/`orderBy`), NOT SQL names — Drizzle renders each
   * column's own SQL name, so a table declaring `clerkUserId: text('clerk_user_id')`
   * takes `select('clerkUserId')` and emits `"clerk_user_id"`.
   *
   * Projection does NOT narrow the read TAG: the tag is the table, and a
   * subscription that read any column of it must still invalidate when any
   * column is written. Narrowing tags to columns would be a different (finer)
   * invalidation model, not an optimization of this one.
   */
  select<K extends keyof T['$inferSelect'] & string>(
    ...cols: [K, ...K[]]
  ): SelectBuilder<T, Pick<T['$inferSelect'], K>> {
    // The tuple type already forbids `select()` at compile time; this guards the
    // untyped-caller path, where an empty projection would silently lower to
    // `SELECT` with no columns.
    if (cols.length === 0) throw new Error('select() requires at least one column')
    return this._with<Pick<T['$inferSelect'], K>>({ projection: cols })
  }

  where(filters: FilterDescriptor | FilterDescriptor[]): SelectBuilder<T, TRow> {
    const toAdd = Array.isArray(filters) ? filters : [filters]
    return this._with({ filters: [...this._clauses.filters, ...toAdd] })
  }

  orderBy(col: string, dir: 'asc' | 'desc' = 'asc'): SelectBuilder<T, TRow> {
    // Rejected here rather than at lowering time, for the same reason `select()`
    // rejects an empty column list: the lowering used to gate on truthiness, so
    // an empty name silently produced an unordered read that the caller believed
    // was sorted — while the write guard, testing `!== undefined`, rejected it.
    if (col === '') throw new Error('orderBy() requires a column name')
    return this._with({ orderByCol: col, orderDir: dir })
  }

  /**
   * Cap the read at `n` rows.
   *
   * Validated at the setter, matching `select()` and `orderBy()`. Postgres
   * rejects a negative, fractional or non-finite LIMIT anyway, but it does so at
   * execution — a driver error naming neither the builder nor the call that
   * produced it. `number` does not narrow to non-negative integers, so this is
   * the only place the mistake can be caught where it was made.
   */
  limit(n: number): SelectBuilder<T, TRow> {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`limit() requires a non-negative integer — got ${n}`)
    }
    return this._with({ limitVal: n })
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  private _buildConditions(columns: Record<string, any>) {
    const conditions = this._clauses.filters.map((f) =>
      drizzleOpMap[f.op](requireColumn(columns, f.column), f.value),
    )
    const tenant = requireTenantScope(this._table, this._tenantScope)
    if (tenant) {
      conditions.unshift(
        drizzleEq(requireColumn(columns, tenant.tenancy.property), tenant.tenantId),
      )
    }
    return conditions
  }

  /**
   * Resolve the projection's JS property keys to Drizzle column objects, in the
   * order named. `requireColumn` throws on an unknown name — a typo'd column
   * would otherwise vanish from the projection and yield rows silently missing a
   * field.
   */
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  private _buildProjection(columns: Record<string, any>) {
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const projected: Record<string, any> = {}
    for (const name of this._clauses.projection ?? []) {
      projected[name] = requireColumn(columns, name)
    }
    return projected
  }

  /**
   * Build the lowered Drizzle select query (projection / where / orderBy / limit
   * applied). Single source of truth shared by `all()` and `toSql()` so a future
   * clause (join, group-by, …) is added once and both paths stay in lockstep —
   * the byte-identical zero-overhead assertion in `toSql()` only stays meaningful
   * if it lowers the exact same query `all()` executes.
   */
  private _buildSelectQuery(limitOverride?: number): LoweredSelect<TRow> {
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    // `DrizzleDb` is `any`, so the whole clause chain below is untyped no matter
    // how it is written — there is no builder type here to preserve. The type
    // comes back at the signature, not from inference.
    let q = this._clauses.projection
      ? this._db.select(this._buildProjection(columns)).from(this._table)
      : this._db.select().from(this._table)
    const conditions = this._buildConditions(columns)
    if (conditions.length > 0) {
      q = q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    }
    if (this._clauses.orderByCol !== undefined) {
      const col = requireColumn(columns, this._clauses.orderByCol)
      // The primary key trails as a tiebreaker, matching the draft coalesce. SQL
      // leaves the order of rows equal on the named column unspecified, so
      // without it the same `orderBy` resolves ties by heap order canonically and
      // by PK under a draft — and a handler cannot tell which handle it holds.
      //
      // This is the whole of the cross-path order guarantee: the two builders
      // agree WHEN A CALLER NAMES A COLUMN. Neither promises anything without
      // `orderBy()` — see `DraftSelectBuilder._buildCoalesceQuery`, which emits a
      // default PK order the canonical path deliberately does not.
      const pkCol = this._pkColumn(columns)
      const named = this._clauses.orderDir === 'desc' ? desc(col) : asc(col)
      q = pkCol && pkCol !== col ? q.orderBy(named, asc(pkCol)) : q.orderBy(named)
    }
    const limit = limitOverride ?? this._clauses.limitVal
    if (limit !== undefined) {
      q = q.limit(limit)
    }
    return q
  }

  /** The table's PK column object, or undefined for a table this resolver cannot
   *  pin to a single column (a composite PK) — in which case no tiebreaker is
   *  emitted rather than an arbitrary one. */
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  private _pkColumn(columns: Record<string, any>) {
    try {
      const pkName = resolvePkColumnName(this._table, getTableConfig(this._table))
      return Object.values(columns).find((c) => (c.name as string) === pkName)
    } catch {
      return undefined
    }
  }

  async all(): Promise<TRow[]> {
    return await this._read()
  }

  /**
   * Tag the read, then execute. `all()` and `first()` share this so the tracker
   * is touched in exactly ONE place: a tag added here (a derived table, an audit
   * hook) reaches both, where two call sites would let a subscription
   * established through `first()` silently miss it.
   *
   * `limitOverride` is how `first()` lowers `LIMIT 1` without assigning
   * `_clauses.limitVal` — that field must mean only "the caller attached
   * `limit()`", because the write guard reads it as intent.
   */
  private async _read(limitOverride?: number): Promise<TRow[]> {
    this._tracker.tablesRead.add(tableTrackingTag(this._table, this._tenantScope))
    // Await here (not a bare return) so errors surface in this async frame and
    // the resolved value is the row array, not the Drizzle builder.
    return await this._buildSelectQuery(limitOverride)
  }

  /**
   * Return the lowered SQL without executing. Used in tests to assert that the
   * canonical read path generates byte-identical SQL when no draft is active —
   * i.e., zero-overhead is structural, not conditional. Builds via the same
   * `_buildSelectQuery()` as `all()`; the only difference is the missing
   * `tablesRead` side-effect and the final `.toSQL()` instead of execute.
   *
   * `limitOverride` mirrors `first()`'s internal `LIMIT 1` pushdown. That
   * pushdown is a lowering-only optimization — with it removed, `first()` still
   * returns the same row from a larger fetch — so no behavioral assertion can
   * catch its loss and this parameter is the only way to pin it.
   */
  toSql(limitOverride?: number): Query {
    return this._buildSelectQuery(limitOverride).toSQL()
  }

  async first(): Promise<TRow | null> {
    const rows = await this._read(1)
    return rows[0] ?? null
  }

  async update(values: Partial<T['$inferInsert']>) {
    if (this._writeError) throw new Error(this._writeError)
    assertNoReadClauses('update', this._clauses)
    assertTenantInput(this._table, values as Record<string, unknown>)
    const patch = withoutUndefined(values as Record<string, unknown>)
    assertRevisionInput(this._table, patch)
    if (Object.keys(patch).length === 0) return []
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const revision = revisionProperty(this._table)
    const valuesWithRevision = revision
      ? { ...patch, [revision]: sql`${requireColumn(columns, revision)} + 1` }
      : patch
    let q = this._db.update(this._table).set(valuesWithRevision)
    const conditions = this._buildConditions(columns)
    if (conditions.length > 0) {
      q = q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    }
    const rows = await q.returning()
    this._tracker.tablesWritten.add(tableTrackingTag(this._table, this._tenantScope))
    return rows
  }

  async delete() {
    if (this._writeError) throw new Error(this._writeError)
    assertNoReadClauses('delete', this._clauses)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const conditions = this._buildConditions(columns)
    const predicate = conditions.length === 1 ? conditions[0] : and(...conditions)
    const revision = revisionProperty(this._table)
    const rows = revision
      ? await this._db.transaction(async (tx: DrizzleDb) => {
          let candidatesQuery = tx.select().from(this._table)
          if (conditions.length > 0) candidatesQuery = candidatesQuery.where(predicate)
          const candidates = (await candidatesQuery) as Record<string, unknown>[]
          candidates.sort((left, right) =>
            rowRevisionSortKey(this._table, this._tenantScope, left).localeCompare(
              rowRevisionSortKey(this._table, this._tenantScope, right),
            ),
          )
          for (const row of candidates) {
            await lockRowRevision(tx, this._table, this._tenantScope, row)
          }

          let lockQuery = tx.select().from(this._table)
          if (conditions.length > 0) lockQuery = lockQuery.where(predicate)
          const locked = (await lockQuery.for('update')) as Record<string, unknown>[]
          for (const row of locked) {
            await preserveRowRevision(tx, this._table, this._tenantScope, row, revision)
          }

          let deletion = tx.delete(this._table)
          if (conditions.length > 0) deletion = deletion.where(predicate)
          return deletion.returning()
        })
      : await (() => {
          let deletion = this._db.delete(this._table)
          if (conditions.length > 0) deletion = deletion.where(predicate)
          return deletion.returning()
        })()
    this._tracker.tablesWritten.add(tableTrackingTag(this._table, this._tenantScope))
    return rows
  }
}

/**
 * Draft-coalescing select builder returned by `DraftDrizzleTracker.from()`.
 *
 * `all()` executes a FULL OUTER JOIN between the base table and its
 * central change relation, coalescing every column so that draft edits win
 * over canonical values, draft inserts appear, and tombstoned rows are
 * excluded.
 *
 * `table_key` is derived automatically from the schema-qualified base relation.
 *
 * READ side (`.all()` / `.first()`): every public filter is lowered against the
 * effective presence-aware value as a bound predicate. Multiple filters and
 * non-primary-key operators therefore select the same row set as canonical
 * reads over the equivalent materialized state.
 *
 * `orderBy`/`limit` are pushed into the coalesce SQL, ordering on the COALESCED
 * value so draft-inserted rows sort by what the draft holds, with the PK kept as
 * a tiebreaker (a FULL OUTER JOIN has no inherent row order).
 *
 * WRITE side (`.where(...).update(vals)` / `.where(...).delete()`): resolves the
 * full effective target set atomically, then routes one sparse upsert or
 * delete operation per primary key into the central relation. This is the write path that
 * makes an unmodified command handler land in the draft overlay.
 */
