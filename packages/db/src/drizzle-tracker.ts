/**
 * DrizzleTracker — fluent query builder wrapping Drizzle that auto-records
 * tablesRead / tablesWritten for reactive invalidation.
 */
import {
  eq as drizzleEq,
  ne as drizzleNe,
  gt as drizzleGt,
  gte as drizzleGte,
  lt as drizzleLt,
  lte as drizzleLte,
  asc,
  desc,
  and,
  sql,
} from 'drizzle-orm'
import type { Query, SQL } from 'drizzle-orm'
import type { PgTableWithColumns } from 'drizzle-orm/pg-core'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { FilterDescriptor } from './operators'
import { getTableName, getTableColumns } from 'drizzle-orm'
import { tryGetTableCapabilities } from './schema'

// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle DB instance type varies by driver; no common typed interface
type DrizzleDb = any
// oxlint-disable-next-line typescript/no-explicit-any -- PgTableWithColumns requires a config generic; any is needed for polymorphic table usage
type AnyTable = PgTableWithColumns<any>

const noTenantScope = Symbol('no tenant scope')
type TenantScope = unknown | typeof noTenantScope

function requireTenantScope(table: AnyTable, tenantScope: TenantScope) {
  const tenancy = tryGetTableCapabilities(table)?.tenancy
  if (!tenancy) return undefined
  if (tenantScope === noTenantScope) {
    throw new Error(
      `Table "${getTableName(table)}" requires tenant scope; call withTenant() with a trusted tenant ID`,
    )
  }
  return { tenancy, tenantId: tenantScope }
}

function assertDraftWriteScope(table: AnyTable, tenantScope: TenantScope): void {
  const tenancy = tryGetTableCapabilities(table)?.tenancy
  if (tenancy) {
    requireTenantScope(table, tenantScope)
    return
  }
  if (tenantScope !== noTenantScope) {
    throw new Error(`Tenant-scoped drafts cannot write global table "${getTableName(table)}"`)
  }
}

function assertTenantInput(table: AnyTable, values: Record<string, unknown>): void {
  const tenancy = tryGetTableCapabilities(table)?.tenancy
  if (!tenancy) return
  if (Object.hasOwn(values, tenancy.property) || Object.hasOwn(values, tenancy.column)) {
    throw new Error(
      `Tenant property "${tenancy.property}" is system-managed and cannot be supplied or updated`,
    )
  }
}

function withoutUndefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}

function qualifiedTableName(table: AnyTable): string {
  const tableName = getTableName(table)
  const schemaName = getTableConfig(table).schema
  return schemaName ? `${schemaName}.${tableName}` : tableName
}

function tableTrackingTag(table: AnyTable, tenantScope: TenantScope): string {
  const tableName = qualifiedTableName(table)
  const tenant = requireTenantScope(table, tenantScope)
  if (!tenant) return tableName
  return `tenant:${encodeURIComponent(String(tenant.tenantId))}:${tableName}`
}

function draftTableTrackingTag(table: AnyTable, tenantScope: TenantScope, draftId: string): string {
  const tableName = `${qualifiedTableName(table)}__draft`
  const tenant = requireTenantScope(table, tenantScope)
  if (!tenant) return tableName
  return `tenant:${encodeURIComponent(String(tenant.tenantId))}:${tableName}:draft:${encodeURIComponent(draftId)}`
}

/**
 * The entire surface `_buildSelectQuery`'s callers touch on a lowered Drizzle
 * select: await it for rows, or lower it to SQL without executing.
 *
 * Declared structurally rather than named because the two branches of that
 * builder — projected and full-row — are different Drizzle types, and because
 * `DrizzleDb` is `any` anyway, so nothing narrower survives the chain. Stating
 * the surface is what re-introduces a type at the boundary: it is why `all()`
 * needs no cast and `toSql()` needs no annotation.
 */
interface LoweredSelect<TRow> extends PromiseLike<TRow[]> {
  toSQL(): Query
}

/**
 * A builder's accumulated clause state, held as one value.
 *
 * Both builders carry this rather than a field each, for two reasons. It is what
 * makes a builder copyable in one expression (see `_with`), and it is the whole
 * argument to `assertNoReadClauses` — so adding a clause means adding a field
 * here, not remembering to thread it through two classes and a guard.
 */
interface ReadClauses {
  /** Never mutated in place — `where()` REPLACES this array on the copy it
   *  returns. `_with` spreads the clause object, so a `.push` here would write
   *  through to every copy sharing the reference. */
  filters: FilterDescriptor[]
  projection?: string[]
  orderByCol?: string
  orderDir: 'asc' | 'desc'
  limitVal?: number
}

/** Fresh state for a builder with nothing attached. A factory, not a shared
 *  constant, so no two builders can ever alias one `filters` array. */
const emptyClauses = (): ReadClauses => ({ filters: [], orderDir: 'asc' })

/**
 * Resolve a JS property key to its Drizzle column, or throw.
 *
 * Uses an own-property check, not truthiness: `columns['constructor']` resolves
 * up `Object.prototype`, so a truthiness test would accept it and lower a
 * column-less SELECT — which Postgres accepts, returning fieldless rows instead
 * of an error.
 *
 * Every clause that names a column goes through here. Open-coding the lookup
 * meant each new clause repeated it, and one copy drifting reintroduces exactly
 * what all of them exist to prevent: a typo'd column silently dropped.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
function requireColumn(columns: Record<string, any>, name: string) {
  if (!Object.hasOwn(columns, name)) throw new Error(`Unknown column: ${name}`)
  return columns[name]
}

/**
 * Reject read-terminal clauses on a write terminal.
 *
 * `from(t).where(...)` builds a row scope; the terminal decides read or write.
 * `where` is a scope modifier and means something to every terminal, but
 * `select` / `orderBy` / `limit` configure what `all()` / `first()` YIELD and
 * mean nothing to `update` / `delete`. Silently dropping them is the hazard:
 *
 *   from(t).where(gt('age', 30)).limit(1).delete()
 *
 * read as "delete one row" and deleted EVERY match. Throwing is the convention
 * this file already uses for a clause a terminal cannot honor (see the draft
 * `transaction` guard and `_resolvePkReadFilter`) — silence is what turns a
 * misread into a wrong result. `select` is included for a second reason:
 * `update`/`delete` return `Promise<any>`, so a handler that visibly projected
 * columns away and then forwarded its RETURNING rows would leak them with no
 * type-level signal at the call site.
 *
 * Shared by both builders so the canonical and draft write paths cannot drift.
 */
function assertNoReadClauses(op: 'update' | 'delete', clauses: ReadClauses): void {
  const attached: string[] = []
  if (clauses.projection !== undefined) attached.push('select()')
  if (clauses.orderByCol !== undefined) attached.push('orderBy()')
  if (clauses.limitVal !== undefined) attached.push('limit()')
  if (attached.length === 0) return
  throw new Error(
    `${attached.join(' / ')} cannot precede ${op}() — ${attached.length > 1 ? 'they configure' : 'it configures'} what a read returns, ` +
      `and would be ignored by the write. To ${op} specific rows, pin them with where(); ` +
      `to ${op} one of many matches, read it first (orderBy/limit/first) and then ${op} by primary key.`,
  )
}

const drizzleOpMap = {
  eq: drizzleEq,
  ne: drizzleNe,
  gt: drizzleGt,
  gte: drizzleGte,
  lt: drizzleLt,
  lte: drizzleLte,
} as const

/**
 * A draft-scoped handle returned by `withDraft(draftId)`. Exposes the same
 * read+write surface shape as `DrizzleTracker`, but every operation is routed at the
 * `<table>__draft` shadow rather than the canonical table:
 *
 *   - `from(table).all()`            → coalesced read (canonical ⊕ draft delta)
 *   - `into(table).insert(rows)`     → sparse upsert into `<table>__draft`
 *   - `from(table).where(eqPk).update(vals)` → sparse cell edit in the shadow
 *   - `from(table).where(eqPk).delete()`     → tombstone row in the shadow
 *
 * The write methods (`into` + the `DraftSelectBuilder.update/delete`) are what
 * make an EXISTING command handler — which writes via `ctx.db.into(table)` /
 * `ctx.db.from(table).where(...).update(...)` — land in the draft overlay
 * UNMODIFIED when `ctx.db = base.withDraft(draftId)`. The handler is unaware it
 * is writing into a draft.
 *
 * `transaction` is present but THROWS: a draft's atomic boundary is the
 * lifecycle's `publish` (which replays the command log inside `applyCommands`'s
 * tracked tx), not a per-handler transaction. It exists (rather than being
 * omitted) so a command handler that mistakenly opens a transaction inside a
 * draft fails with a clear named error instead of a cryptic
 * `undefined is not a function` — the `runHandler` widening erases the
 * structural difference, so the runtime guard is the only signal.
 */
export interface DraftDrizzleTracker {
  tablesRead: Set<string>
  tablesWritten: Set<string>
  /** Raw Drizzle instance, same as `DrizzleTracker.raw`. */
  raw: DrizzleDb
  from<T extends AnyTable>(table: T): DraftSelectBuilder<T>
  into<T extends AnyTable>(table: T): DraftInsertBuilder<T>
  /** Always throws — drafts have no per-handler transaction (publish owns atomicity). */
  transaction<R>(fn: (tx: DrizzleTracker) => Promise<R>, opts?: TransactionOptions): Promise<R>
}

export interface DrizzleTracker {
  tablesRead: Set<string>
  tablesWritten: Set<string>
  /** Raw Drizzle instance for complex queries (joins, raw SQL). Caller must manually
   *  record table reads/writes for reactive tracking to work. */
  raw: DrizzleDb
  /** Trusted opaque tenant ID carried by this handle, when scoped. */
  readonly tenantId?: unknown
  from<T extends AnyTable>(table: T): SelectBuilder<T>
  into<T extends AnyTable>(table: T): InsertBuilder<T>
  /** Bind trusted tenant scope. Tenant tables fail closed until a scope is bound. */
  withTenant(tenantId: unknown): DrizzleTracker
  /**
   * Run `fn` inside an atomic transaction whose writes still emit reactive Tags.
   *
   * `fn` receives a fresh DrizzleTracker bound to the native transaction handle. On
   * commit (fn resolves) the inner reads/writes merge into this tracker's sets,
   * so a successful batch's write Tags flush to invalidation as one set. On
   * rollback (fn throws, or `tx.raw.rollback()`) the merge is skipped and the
   * transaction emits nothing.
   *
   * This rollback-emits-nothing property is what preview's execute-then-rollback
   * builds on, but preview is not fully served by this signature alone: rollback
   * only happens via a throw, which destroys the `R` return channel — a preview
   * that must roll back *and* return a diff has to smuggle the diff through a
   * thrown sentinel. The diff-returning preview contract is a later layer's to design;
   * this primitive only guarantees the atomicity + no-emit-on-rollback floor.
   *
   * Atomicity is the lowering's native transaction; this only adds Tag-tracking
   * over it. Nested transactions flatten: inner Tags merge into their parent
   * tracker, so only the outermost call's set reaches invalidation.
   *
   * `opts` is passed through to the lowering's native transaction. Isolation
   * level / access mode can only be set at transaction start — once `fn` runs the
   * transaction is already open and `tx.raw` offers no path to set them — so this
   * slot is the only entry point for them, and the contract carries it now even
   * though no caller sets it yet.
   */
  transaction<R>(fn: (tx: DrizzleTracker) => Promise<R>, opts?: TransactionOptions): Promise<R>
  /**
   * Return a draft-coalescing read handle for the given draft ID.
   *
   * `handle.from(table).all()` executes a FULL OUTER JOIN coalesce between the
   * base table and its `<table>__draft` shadow, applying delta edits, surfacing
   * draft inserts, and suppressing tombstoned rows — all without touching the
   * canonical `from().all()` code path. A no-draft read is structurally
   * zero-overhead: it never reaches the coalesce logic.
   *
   * Shadow rows carry an explicit `__overrides` property set. A property present
   * there overrides canonical even when its stored value is SQL NULL; an omitted
   * or `undefined` input leaves the effective value unchanged. Deleting a row is
   * expressed via `__tombstone`.
   */
  withDraft(draftId: string): DraftDrizzleTracker
}

/**
 * Lowering-agnostic transaction options, passed through to the native
 * transaction. These two fields are the conceptual subset every SQL dialect
 * shares (a dialect with no analog ignores them); dialect-specific options
 * (e.g. Postgres `deferrable`) stay behind subpaths per the db dialect policy.
 */
export interface TransactionOptions {
  isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'
  accessMode?: 'read write' | 'read only'
}

/**
 * `TRow` is the shape `all()`/`first()` resolve to. It defaults to the full row
 * and narrows to a `Pick` once `select()` names columns — the projection is a
 * type-level fact, so a projected read cannot be mistaken for a full row.
 */
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
    if (Object.keys(patch).length === 0) return []
    let q = this._db.update(this._table).set(patch)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const conditions = this._buildConditions(getTableColumns(this._table) as Record<string, any>)
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
    let q = this._db.delete(this._table)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const conditions = this._buildConditions(getTableColumns(this._table) as Record<string, any>)
    if (conditions.length > 0) {
      q = q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    }
    const rows = await q.returning()
    this._tracker.tablesWritten.add(tableTrackingTag(this._table, this._tenantScope))
    return rows
  }
}

/**
 * Draft-coalescing select builder returned by `DraftDrizzleTracker.from()`.
 *
 * `all()` executes a FULL OUTER JOIN between the base table and its
 * `<table>__draft` shadow, coalescing every column so that draft edits win
 * over canonical values, draft inserts appear, and tombstoned rows are
 * excluded.
 *
 * The draft table name is derived automatically: `<base_table>__draft`.
 * No application-specific mapping is required.
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
 * tombstone per primary key into `<table>__draft`. This is the write path that
 * makes an unmodified command handler land in the draft overlay.
 */
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

  /**
   * Narrow the coalesced read to `cols`, by property key — same vocabulary and
   * same semantics as `SelectBuilder.select`, which matters because handlers are
   * authored against `DrizzleTracker` (`create.ts` hands them
   * `db: tracked as DrizzleTracker`) and cannot see which handle they hold, so
   * a clause that silently changed meaning under a draft would be undetectable
   * at the call site. Every read clause therefore lands on both builders with the
   * same vocabulary and the same meaning — `select` here, `orderBy`/`limit` below.
   *
   * The `K` bound matches the canonical builder's. Anything weaker would let code
   * holding a draft handle directly typo a column that the canonical path rejects
   * at compile time, which is the same asymmetry this comment claims not to have.
   *
   * Projection only shrinks the coalesce's SELECT list. The join predicate, the
   * tombstone filter and the ORDER BY reference their columns directly and do
   * not read that list, so a projection that omits the primary key still joins,
   * still suppresses tombstones, and still orders correctly.
   */
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
   * Sparse cell-edit into the shadow: upsert `(draft_id, <pk>)` setting ONLY the
   * columns present in `values` (+ `__tombstone = false`), so a draft update of
   * one field does not clobber other fields. Mirrors the canonical
   * `from(t).where(eq('id', x)).update(vals)` shape a command handler emits, but
   * the write lands in `<table>__draft`, not the canonical table.
   *
   * Filters have full effective-row parity with canonical updates: every row
   * matched by the composed predicate receives the sparse patch. Returns the
   * resulting effective rows. Read-only select/order/limit clauses are rejected
   * because a write cannot honor their return-shaping semantics.
   */
  async update(values: Partial<T['$inferInsert']>): Promise<Record<string, unknown>[]> {
    assertNoReadClauses('update', this._clauses)
    assertDraftWriteScope(this._table, this._tenantScope)
    const patch = withoutUndefined(values as Record<string, unknown>)
    assertTenantInput(this._table, patch)
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
        await writeShadowRow(txDb, txDraft, this._table, this._draftId, this._tenantScope, {
          pkValue,
          values: patch,
          tombstone: false,
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
   * Tombstone the row in the shadow: upsert `(draft_id, <pk>, __tombstone=true)`
   * so the coalesce read suppresses it. Mirrors the canonical
   * `from(t).where(eq('id', x)).delete()` a command handler emits.
   *
   * Filters have full effective-row parity with canonical deletes; every match
   * receives a tombstone in the shadow.
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
        await writeShadowRow(txDb, txDraft, this._table, this._draftId, this._tenantScope, {
          pkValue: match[pkProperty],
          values: {},
          tombstone: true,
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
    // Record the base table read AND the shadow-table read. The draft read's
    // result genuinely depends on `<table>__draft`: a write to it (e.g.
    // `into(todosDraft).insert(...)` publishing tablesWritten={'todos__draft'})
    // must invalidate this subscription, which only happens if the shadow table
    // is in tablesRead so the reactive router's read∩write intersection fires.
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
    const draftTableName = `${tableName}__draft`

    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const colEntries = Object.entries(columns)

    // Single getTableConfig() read shared by PK resolution + schema qualification.
    const config = getTableConfig(this._table)
    const pkColName = resolvePkColumnName(this._table, config)

    const tenant = requireTenantScope(this._table, this._tenantScope)
    const identityColumns = new Set([pkColName])
    if (tenant) identityColumns.add(tenant.tenancy.column)
    const effectiveExpression = (sqlName: string) => {
      if (identityColumns.has(sqlName)) return `COALESCE(d."${sqlName}", b."${sqlName}")`
      const literal = sqlName.replace(/'/g, "''")
      return (
        `CASE WHEN '${literal}' = ANY(d."__overrides") THEN d."${sqlName}" ` +
        `WHEN cardinality(d."__overrides") = 0 AND d."${sqlName}" IS NOT NULL THEN d."${sqlName}" ` +
        `ELSE b."${sqlName}" END`
      )
    }

    // Schema-qualify both relations when the table lives outside the default
    // schema (pgSchema('app').table(...)). Canonical Drizzle selects emit the
    // schema prefix; the raw coalesce SQL must match or it reads the wrong
    // relation / fails with relation-not-found.
    const schema = config.schema
    const baseRel = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`
    const draftRel = schema ? `"${schema}"."${draftTableName}"` : `"${draftTableName}"`

    // Build a presence-aware effective value for every selected column.
    //
    // The JOIN/COALESCE operate on the SQL column name (col.name), but the
    // result is aliased to the Drizzle PROPERTY KEY so the returned row shape is
    // byte-identical to canonical `from().all()`. Without this, a column like
    // `createdAt: timestamp('created_at')` would come back as `created_at` and
    // consumers reading `row.createdAt` would see undefined.
    //
    // A projection narrows THIS list and nothing else: the join predicate, the
    // tombstone WHERE, the pk predicate and the ORDER BY all name their columns
    // directly below, so omitting the PK from the output leaves them intact.
    const selectedEntries = this._clauses.projection
      ? this._clauses.projection.map(
          // `requireColumn` throws on an unknown name rather than dropping the
          // column from the result — and does an own-property check, so a name
          // like `constructor` cannot resolve up `Object.prototype`.
          (propKey) => [propKey, requireColumn(columns, propKey)] as const,
        )
      : colEntries

    const colSelects = selectedEntries
      .map(([propKey, col]) => {
        const sqlName = col.name as string
        return `${effectiveExpression(sqlName)} AS "${propKey}"`
      })
      .join(', ')

    // Build the coalesce query using a Drizzle sql-tagged-template so draftId is
    // sent as a bound parameter (not interpolated into the SQL string).
    // Table/column names come from schema introspection (not user input) and are
    // double-quoted; they are safe to include as raw SQL fragments.
    //
    // The draft table is pre-filtered by draftId in a subquery BEFORE the FULL
    // OUTER JOIN. This is critical: a bare `FULL OUTER JOIN draft ON pk AND
    // draft_id = $id` leaks unrelated draft rows (for other draftIds) as
    // right-side-only rows when $id doesn't match — the subquery eliminates
    // that hazard by restricting the right side to exactly this draft's rows.
    const prefix = sql.raw(
      `SELECT ${colSelects} ` +
        `FROM ${baseRel} b ` +
        `FULL OUTER JOIN (SELECT * FROM ${draftRel} WHERE "draft_id" = `,
    )

    // The join + tombstone-suppression WHERE is a single shared fragment so the
    // filtered and unfiltered paths can never diverge on it. The optional pk
    // predicate composes with the tombstone WHERE via COALESCE(d.pk, b.pk) — the
    // SAME expression the ORDER BY uses, so it pins a draft-insert row (base side
    // NULL) or a canonical row (draft side NULL) identically. It sits BEFORE the
    // ORDER BY and AFTER the tombstone clause, so a tombstoned PK-pinned read
    // still returns no row.
    const tenantJoin = tenant
      ? ` AND b."${tenant.tenancy.column}" = d."${tenant.tenancy.column}"`
      : ''
    const joinAndTombstone = sql.raw(
      `) d ON b."${pkColName}" = d."${pkColName}"${tenantJoin} ` +
        `WHERE COALESCE(d."__tombstone", false) = false`,
    )
    // The pk order plays two different roles, and only one of them is a promise.
    //
    // As the TRAILING TIEBREAKER (when a caller names a column) it is the
    // cross-path guarantee: canonical lowers the same tiebreaker, so the two
    // handles resolve ties identically and a preview agrees with its publish.
    //
    // As the DEFAULT (no `orderBy()` at all) it is draft-only, and deliberately
    // NOT matched canonically — canonical emits no ORDER BY there, because
    // `with-draft.test.ts` pins its lowering as byte-identical to plain Drizzle.
    // The asymmetry is safe in the direction it runs: the contract is "no order
    // unless you ask", so the draft is free to be stronger, and a caller relying
    // on unordered row order is already broken on the canonical path. It is not
    // safe in the other direction — this is a FULL OUTER JOIN, whose output
    // order is join-algorithm-dependent rather than heap-stable, so dropping the
    // default would make an unfiltered `first()` genuinely arbitrary.
    const pkOrder = effectiveExpression(pkColName)
    let orderByClause = ` ORDER BY ${pkOrder}`
    if (this._clauses.orderByCol !== undefined) {
      // `!== undefined`, not truthiness, and the same test the write guard uses:
      // when the two disagreed, `orderBy('')` produced an unordered read the
      // caller believed was sorted while still blocking a later write. The empty
      // name is now rejected in the setter; this stays aligned regardless.
      const col = requireColumn(columns, this._clauses.orderByCol)
      const sqlName = col.name as string
      const dir = this._clauses.orderDir === 'desc' ? ' DESC' : ''
      orderByClause = ` ORDER BY ${effectiveExpression(sqlName)}${dir}, ${pkOrder}`
    }
    const orderBy = sql.raw(orderByClause)
    // Bound param, not interpolated — the value is caller-supplied.
    const limitVal = limitOverride ?? this._clauses.limitVal
    const limit = limitVal === undefined ? sql.raw('') : sql`${sql.raw(' LIMIT ')}${limitVal}`
    const sqlOperators = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const
    const filterFragments = this._clauses.filters.map((filter) => {
      const column = requireColumn(columns, filter.column)
      return sql`${sql.raw(
        ` AND ${effectiveExpression(column.name as string)} ${sqlOperators[filter.op]} `,
      )}${sql.param(mapColumnValue(column, filter.value))}`
    })
    const filterPredicate = sql.join(filterFragments, sql.raw(''))
    const tenantShadowPredicate = tenant
      ? sql`${sql.raw(` AND "${tenant.tenancy.column}" = `)}${sql.param(tenant.tenantId)}`
      : sql.raw('')
    const tenantEffectivePredicate = tenant
      ? sql`${sql.raw(
          ` AND ${effectiveExpression(tenant.tenancy.column)} = `,
        )}${sql.param(tenant.tenantId)}`
      : sql.raw('')

    const query = sql`${prefix}${sql.param(this._draftId)}${tenantShadowPredicate}${joinAndTombstone}${tenantEffectivePredicate}${filterPredicate}${orderBy}${limit}`

    return { query, colEntries }
  }

  /**
   * Coalesced first-row read. Mirrors `SelectBuilder.first()` so an UNMODIFIED
   * handler that calls `ctx.db.from(table).where(eq('id', x)).first()` works
   * inside a draft (the `runHandler` widening hides the structural gap from the
   * typechecker). Shares the effective-row filter lowering with `all()`;
   * any supported canonical filter can select the first matching draft row.
   *
   * Lowers `LIMIT 1` as an override rather than setting `_clauses.limitVal`, for the
   * same reason as `SelectBuilder.first()` — that field is what the write guard
   * reads to tell a caller-attached `limit()` from an internal one. Before the
   * limit was pushed down at all, this had to fetch the whole coalesced set to
   * return one row.
   */
  async first(): Promise<Record<string, unknown> | null> {
    const rows = await this._coalescedRead(1)
    return rows[0] ?? null
  }
}

/**
 * Normalize a raw `db.execute(sql)` result to a plain row array across drivers.
 *
 * The two drivers this package supports return DIFFERENT shapes from a raw
 * `.execute()`:
 *   - PGlite (drizzle-orm/pglite): a `{ rows, fields, affectedRows }` object —
 *     rows live under `.rows`.
 *   - postgres-js (drizzle-orm/postgres-js, the production path in `createDb`):
 *     the result IS the row list (a postgres.js `RowList`, an Array subclass) —
 *     there is no `.rows` wrapper, so `(result as {rows}).rows` is `undefined`.
 *
 * This normalizer is the production-correctness fix: prefer `.rows` when the
 * driver wraps, otherwise treat an array-shaped result as the rows directly.
 *
 * Exported so the postgres-js (array) branch — the production path — can be
 * unit-tested directly; the integration tests only exercise PGlite's `{ rows }`.
 */
export function normalizeExecuteRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return result as Record<string, unknown>[]
  }
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  throw new Error(
    'DraftSelectBuilder: unexpected db.execute() result shape — expected an array of rows ' +
      '(postgres-js) or a { rows } object (PGlite).',
  )
}

/**
 * Decode one normalized coalesce row through its columns' driver codecs — the
 * READ mirror of the write-path encode (`toSqlColumnMap` / `mapColumnValue`).
 *
 * `colEntries` is the `[propKey, col]` list from `getTableColumns()`; the
 * coalesce SELECT aliases every column to its propKey (`AS "propKey"`), so a
 * returned row is keyed by propKey and decodes 1:1 against this list. Each value
 * is routed through the column's own `mapFromDriverValue` (via
 * `mapColumnValueFromDriver`), which is the only driver-independent decode — see
 * `DraftSelectBuilder.all()` for why the column codec (not a hand-rolled
 * `typeof === 'string' ? JSON.parse`) is load-bearing: it decodes EVERY
 * non-identity column type (jsonb, timestamp, …), not just jsonb. A key present
 * in the row but absent from the schema is left untouched.
 *
 * Exported so the postgres-js decode path — a jsonb column arriving as a raw
 * JSON STRING, the production shape the PGlite integration tests cannot produce
 * (PGlite auto-parses jsonb) — can be unit-tested directly, the same reason
 * `normalizeExecuteRows` is exported.
 */
export function decodeRowFromDriver(
  row: Record<string, unknown>,
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  colEntries: [string, any][],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row }
  for (const [propKey, col] of colEntries) {
    if (!(propKey in out)) continue
    out[propKey] = mapColumnValueFromDriver(col, out[propKey])
  }
  return out
}

/**
 * Resolve the single PK column's SQL name from a table's full Drizzle config,
 * covering all the ways a PK is declared:
 *   - inline `.primaryKey()`          → column-level `.primary === true`
 *   - serial PKs (defineSchema)       → marked primary in schema.ts, so also column-level
 *   - table-level `primaryKey({...})`  → only visible in `config.primaryKeys`
 *   - no explicit PK                  → fall back to a column literally named `id`
 *
 * Composite PKs (2+ columns) are unsupported — the shadow join/upsert is
 * single-key — so we throw a clear error rather than silently keying on the
 * wrong column. Shared by the draft READ coalesce (`DraftSelectBuilder.all`)
 * and the draft WRITE path (`writeShadowRow` / `DraftSelectBuilder.update/delete`)
 * so both key on the identical column.
 */
export function resolvePkColumnName(
  table: AnyTable,
  config: ReturnType<typeof getTableConfig>,
): string {
  const tableName = getTableName(table)

  // Table-level primaryKey({ columns: [...] }) — authoritative when present.
  if (config.primaryKeys.length > 0) {
    const pk = config.primaryKeys[0]
    if (pk.columns.length > 1) {
      throw new Error(
        `draft overlay: table "${tableName}" has a composite primary key ` +
          `(${pk.columns.map((c) => c.name).join(', ')}). Composite PKs are not supported ` +
          `by the draft overlay (single-key shadow join/upsert).`,
      )
    }
    return pk.columns[0].name
  }

  // Inline column-level .primaryKey() (and serial PKs, which schema.ts marks primary).
  const inlinePks = config.columns.filter((c) => c.primary === true)
  if (inlinePks.length > 1) {
    throw new Error(
      `draft overlay: table "${tableName}" has multiple primary-key columns ` +
        `(${inlinePks.map((c) => c.name).join(', ')}). Composite PKs are not supported ` +
        `by the draft overlay (single-key shadow join/upsert).`,
    )
  }
  if (inlinePks.length === 1) return inlinePks[0].name

  // Last resort: a column whose SQL name is literally "id". This assumes the
  // `id` column is the row identity (it is for every defineSchema table —
  // serial PKs are now marked primary above — and the documented convention
  // for raw pgTable callers). If a table has a non-unique `id` that is NOT the
  // identity, the shadow join/upsert would mis-key; such a table must declare an
  // explicit primary key so resolution takes a branch above instead.
  const idCol = config.columns.find((c) => c.name === 'id')
  if (idCol) return idCol.name

  throw new Error(
    `draft overlay: table "${tableName}" has no primary key column and no column named "id". ` +
      `Cannot key the draft shadow.`,
  )
}

/**
 * Map a record keyed by Drizzle PROPERTY keys (the shape a handler passes to
 * `.insert()` / `.update()`) to SQL column names, for the shadow upsert which
 * speaks raw SQL. A property whose key is not a real column is dropped (the
 * caller's schema is the source of truth for the shadow's column set).
 *
 * Each value is routed through the Drizzle column codec (`col.mapToDriverValue`)
 * so it is bound exactly as the canonical INSERT path would bind it. This is
 * load-bearing for non-identity codecs: a `jsonb('fields')` column serializes
 * its JS array/object to a JSON string here (the codec is `JSON.stringify`),
 * matching what Drizzle's own insert lowering emits. Without it the raw JS value
 * binds straight to the driver and a `jsonb` column receives a JS array/object,
 * producing a type error or stored garbage. Columns with an identity codec
 * (text/integer/boolean) are unaffected — `mapToDriverValue` returns the value
 * unchanged for them.
 */
function toSqlColumnMap(
  table: AnyTable,
  values: Record<string, unknown>,
): { sqlName: string; value: unknown }[] {
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  const columns = getTableColumns(table) as Record<string, any>
  const out: { sqlName: string; value: unknown }[] = []
  for (const [propKey, value] of Object.entries(values)) {
    if (value === undefined) continue
    const col = columns[propKey]
    if (!col) continue
    out.push({ sqlName: col.name as string, value: mapColumnValue(col, value) })
  }
  return out
}

/**
 * Route a value through a Drizzle column's driver codec, mirroring the canonical
 * INSERT/UPDATE lowering. A `null`/`undefined` is passed through untouched: a
 * codec like `jsonb`'s `JSON.stringify` would otherwise turn `null` into the
 * literal string `"null"` (and `undefined` into `undefined`), corrupting the
 * "no override" sentinel the shadow read relies on. For every supported column
 * type, a real value (`fields: [...]`, `done: true`) is the only case that needs
 * a non-identity codec, and those are never null.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
function mapColumnValue(col: any, value: unknown): unknown {
  if (value === null || value === undefined) return value
  return col.mapToDriverValue(value)
}

/**
 * READ mirror of `mapColumnValue`: route a RAW driver value through a Drizzle
 * column's decode codec (`col.mapFromDriverValue`), the inverse of the write
 * path's `mapToDriverValue`. `mapFromDriverValue` is the standard PgColumn decode
 * method — defined as identity on the base `Column` and overridden per type
 * (jsonb/json → `JSON.parse`-when-string, timestamp → `Date`, …).
 *
 * `null`/`undefined` is passed through untouched, mirroring the write side: a
 * coalesced row carries already-merged columns (no `__tombstone` column in the
 * output), and a NULL there means "no override / SQL NULL" — never a value to
 * decode. (jsonb's `mapFromDriverValue` is string-guarded, so it would no-op on
 * null anyway, but the explicit passthrough keeps the read/write symmetry exact.)
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
function mapColumnValueFromDriver(col: any, value: unknown): unknown {
  if (value === null || value === undefined) return value
  return col.mapFromDriverValue(value)
}

/**
 * Core draft WRITE primitive: upsert ONE sparse row into `<table>__draft`.
 *
 * Sparse semantics — the upsert sets only `(draft_id, <pk>, <provided cols>,
 * __tombstone)`. ON CONFLICT (draft_id, <pk>) it updates ONLY the provided
 * columns + `__tombstone`, so two successive draft edits of different fields on
 * the same row ACCUMULATE rather than clobber. A tombstone is just an upsert
 * with `__tombstone = true` and no value columns.
 *
 * `draftId` and every value are sent as BOUND parameters via the Drizzle `sql`
 * tag (guard-the-sink). Table/column names come from schema introspection (not
 * user input) and are double-quoted, safe as raw SQL fragments. The shadow read
 * (`DraftSelectBuilder.all`) and this writer agree on the `(draft_id, <pk>,
 * __tombstone)` shape by convention; the shadow table DDL is the app/host's to
 * provision (sparse columns default NULL, composite PK `(draft_id, <pk>)`).
 *
 * Records `tablesWritten = '<table>__draft'` so the shadow write invalidates the
 * draft-coalesced reads (which read `<table>__draft`), NOT canonical readers.
 */
async function writeShadowRow(
  db: DrizzleDb,
  tracker: { tablesWritten: Set<string> },
  table: AnyTable,
  draftId: string,
  tenantScope: TenantScope,
  opts: { pkValue: unknown; values: Record<string, unknown>; tombstone: boolean },
): Promise<Record<string, unknown>[]> {
  const tableName = getTableName(table)
  const draftTableName = `${tableName}__draft`
  const config = getTableConfig(table)
  const pkColName = resolvePkColumnName(table, config)
  const schema = config.schema
  const draftRel = schema ? `"${schema}"."${draftTableName}"` : `"${draftTableName}"`

  // Route the PK value through its column codec too, so a PK whose type has a
  // non-identity codec binds identically to the canonical path. PKs are
  // typically uuid/text/serial (identity codec → no-op), but routing rather than
  // assuming keeps the write path codec-correct for any PK column type.
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  const columns = getTableColumns(table) as Record<string, any>
  const pkCol = Object.values(columns).find((c) => (c.name as string) === pkColName)
  const pkValue = pkCol ? mapColumnValue(pkCol, opts.pkValue) : opts.pkValue
  const tenant = requireTenantScope(table, tenantScope)
  const tenantColumn = tenant ? requireColumn(columns, tenant.tenancy.property) : undefined
  const tenantValue = tenantColumn ? mapColumnValue(tenantColumn, tenant?.tenantId) : undefined

  // Provided value columns (sparse), excluding the PK (carried separately) and
  // any accidental __tombstone / draft_id passthrough (owned by this writer).
  const valueCols = toSqlColumnMap(table, opts.values).filter(
    (c) =>
      c.sqlName !== pkColName &&
      c.sqlName !== tenant?.tenancy.column &&
      c.sqlName !== '__tombstone' &&
      c.sqlName !== 'draft_id',
  )

  // INSERT column list + bound-parameter VALUES list. Order:
  //   draft_id, <pk>, <provided value cols...>, __tombstone
  const insertCols = [
    'draft_id',
    ...(tenant ? [tenant.tenancy.column] : []),
    pkColName,
    ...valueCols.map((c) => c.sqlName),
    '__overrides',
    '__tombstone',
  ]
  const insertColSql = insertCols.map((c) => `"${c}"`).join(', ')

  // ON CONFLICT (draft_id, <pk>) DO UPDATE: only the provided value cols +
  // __tombstone. (A tombstone with no value cols just flips __tombstone.)
  const updateAssignments = [
    ...valueCols.map((c) => `"${c.sqlName}" = EXCLUDED."${c.sqlName}"`),
    `"__overrides" = COALESCE("${draftTableName}"."__overrides", ARRAY[]::text[]) || EXCLUDED."__overrides"`,
    `"__tombstone" = EXCLUDED."__tombstone"`,
  ].join(', ')

  // Assemble parameterized VALUES. Every dynamic value is a bound param; column
  // and relation names are introspected identifiers spliced via sql.raw.
  const head = sql.raw(`INSERT INTO ${draftRel} (${insertColSql}) VALUES (`)
  const parts: ReturnType<typeof sql>[] = [head, sql`${sql.param(draftId)}`]
  if (tenant) parts.push(sql.raw(', '), sql`${sql.param(tenantValue)}`)
  parts.push(sql.raw(', '), sql`${sql.param(pkValue)}`)
  for (const c of valueCols) {
    parts.push(sql.raw(', '), sql`${sql.param(c.value)}`)
  }
  parts.push(sql.raw(', '), sql`${sql.param(valueCols.map((column) => column.sqlName))}`)
  parts.push(sql.raw(', '), sql`${sql.param(opts.tombstone)}`)
  const conflictColumns = ['draft_id', ...(tenant ? [tenant.tenancy.column] : []), pkColName]
    .map((column) => `"${column}"`)
    .join(', ')
  parts.push(
    sql.raw(`) ON CONFLICT (${conflictColumns}) DO UPDATE SET ${updateAssignments} RETURNING *`),
  )
  const query = sql.join(parts, sql.raw(''))

  const result = await db.execute(query)
  tracker.tablesWritten.add(draftTableTrackingTag(table, tenantScope, draftId))
  return normalizeExecuteRows(result)
}

/**
 * Insert builder returned by `DraftDrizzleTracker.into(table)`. Routes
 * `.insert(rows)` into the `<table>__draft` shadow as a sparse upsert per row
 * (each row carrying the full PK + columns, `__tombstone = false`). Mirrors the
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
      const r = row as Record<string, unknown>
      assertTenantInput(this._table, r)
      const pkValue = pkPropKey !== undefined ? r[pkPropKey] : r[pkColName]
      if (pkValue === undefined || pkValue === null) {
        throw new Error(
          `DraftInsertBuilder.insert(): row is missing primary key "${pkPropKey ?? pkColName}". ` +
            `Draft inserts require a client-minted PK so the shadow row is addressable.`,
        )
      }
      // Pass the full row as sparse values; writeShadowRow drops the PK column
      // (carried separately) and any reserved shadow columns.
      await writeShadowRow(this._db, this._tracker, this._table, this._draftId, this._tenantScope, {
        pkValue,
        values: r,
        tombstone: false,
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

export class InsertBuilder<T extends AnyTable> {
  private _table: T
  private _db: DrizzleDb
  private _tracker: DrizzleTracker
  private _tenantScope: TenantScope

  constructor(table: T, db: DrizzleDb, tracker: DrizzleTracker, tenantScope: TenantScope) {
    this._table = table
    this._db = db
    this._tracker = tracker
    this._tenantScope = tenantScope
  }

  async insert(values: T['$inferInsert'] | T['$inferInsert'][]) {
    const rows = Array.isArray(values) ? values : [values]
    const tenant = requireTenantScope(this._table, this._tenantScope)
    const scopedRows = rows.map((row) => {
      const record = row as Record<string, unknown>
      assertTenantInput(this._table, record)
      const sanitized = withoutUndefined(record)
      return tenant ? { ...sanitized, [tenant.tenancy.property]: tenant.tenantId } : sanitized
    })
    const inserted = await this._db.insert(this._table).values(scopedRows).returning()
    this._tracker.tablesWritten.add(tableTrackingTag(this._table, this._tenantScope))
    return inserted
  }
}

export function createDrizzleTracker(
  drizzleDb: DrizzleDb,
  tenantScope: TenantScope = noTenantScope,
  sharedTracking?: { tablesRead: Set<string>; tablesWritten: Set<string> },
): DrizzleTracker {
  const tracker: DrizzleTracker = {
    tablesRead: sharedTracking?.tablesRead ?? new Set(),
    tablesWritten: sharedTracking?.tablesWritten ?? new Set(),
    raw: drizzleDb,
    tenantId: tenantScope === noTenantScope ? undefined : tenantScope,
    from<T extends AnyTable>(table: T) {
      return new SelectBuilder(table, drizzleDb, tracker, tenantScope)
    },
    into<T extends AnyTable>(table: T) {
      return new InsertBuilder(table, drizzleDb, tracker, tenantScope)
    },
    withTenant(tenantId: unknown) {
      if (tenantId === null || tenantId === undefined) {
        throw new Error('withTenant() requires a non-null trusted tenant ID')
      }
      if (tenantScope !== noTenantScope && tenantScope !== tenantId) {
        throw new Error('A tenant-scoped database handle cannot change tenant scope')
      }
      if (tenantScope === tenantId) return tracker
      return createDrizzleTracker(drizzleDb, tenantId, {
        tablesRead: tracker.tablesRead,
        tablesWritten: tracker.tablesWritten,
      })
    },
    withDraft(draftId: string): DraftDrizzleTracker {
      const draftHandle: DraftDrizzleTracker = {
        tablesRead: tracker.tablesRead,
        tablesWritten: tracker.tablesWritten,
        raw: drizzleDb,
        from<T extends AnyTable>(table: T) {
          const capabilities = tryGetTableCapabilities(table)
          const isTenantReadingGlobal = tenantScope !== noTenantScope && !capabilities?.tenancy
          if (capabilities?.draftable === false || isTenantReadingGlobal) {
            const writeError = isTenantReadingGlobal
              ? `Tenant-scoped drafts cannot write global table "${getTableName(table)}"`
              : `Table "${getTableName(table)}" is not draftable; declare it with .draftable() before writing through withDraft()`
            return new SelectBuilder(
              table,
              drizzleDb,
              tracker,
              tenantScope,
              emptyClauses(),
              writeError,
            ) as unknown as DraftSelectBuilder<T>
          }
          return new DraftSelectBuilder(table, drizzleDb, draftId, draftHandle, tenantScope)
        },
        into<T extends AnyTable>(table: T) {
          if (tryGetTableCapabilities(table)?.draftable === false) {
            throw new Error(
              `Table "${getTableName(table)}" is not draftable; declare it with .draftable() before writing through withDraft()`,
            )
          }
          return new DraftInsertBuilder(table, drizzleDb, draftId, draftHandle, tenantScope)
        },
        transaction<R>(
          _fn: (tx: DrizzleTracker) => Promise<R>,
          _opts?: TransactionOptions,
        ): Promise<R> {
          // A command handler must not open its own transaction inside a draft —
          // the draft's atomic boundary is the lifecycle's `publish` (one tracked
          // tx via applyCommands). Fail loud with a named contract message rather
          // than a cryptic `undefined is not a function` from the runHandler cast.
          throw new Error(
            'DraftDrizzleTracker.transaction() is not supported: a draft handler cannot open its own ' +
              'transaction — the draft atomic boundary is the lifecycle `publish` (which replays ' +
              'the command log inside one tracked transaction).',
          )
        },
      }
      return draftHandle
    },
    async transaction<R>(
      fn: (tx: DrizzleTracker) => Promise<R>,
      opts?: TransactionOptions,
    ): Promise<R> {
      // The lowering owns atomicity: Drizzle's native transaction provides the
      // tx handle and commits/rolls back. We add Tag-tracking by wrapping that
      // handle in a fresh DrizzleTracker. If `fn` throws, calls rollback, or the
      // COMMIT itself fails, the native transaction rejects this await before
      // the merge below runs — so a non-committed transaction merges nothing
      // and emits no Tags. The merge-after-await placement IS the guarantee;
      // there is deliberately no `committed` flag to drift out of sync.
      let inner: DrizzleTracker | undefined
      const result = await drizzleDb.transaction(async (txHandle: DrizzleDb) => {
        inner = createDrizzleTracker(txHandle, tenantScope)
        return fn(inner)
      }, opts)
      // Reached only on commit. Flush the transaction's accumulated Tags up to
      // the caller's tracker (the call-scope set that reaches invalidation).
      // tablesRead is merged too (intentional): a tx that reads to compute a
      // write contributes those reads to the call's read-set, same as a
      // non-transactional handler would.
      if (inner) {
        for (const t of inner.tablesRead) tracker.tablesRead.add(t)
        for (const t of inner.tablesWritten) tracker.tablesWritten.add(t)
      }
      return result
    },
  }
  return tracker
}

/** Create a fresh DrizzleTracker that shares the same Drizzle connection but with empty tracking sets */
export function resetTracking(tracked: DrizzleTracker): DrizzleTracker {
  return tracked.tenantId === undefined
    ? createDrizzleTracker(tracked.raw)
    : createDrizzleTracker(tracked.raw, tracked.tenantId)
}
