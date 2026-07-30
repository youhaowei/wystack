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
import type { Query } from 'drizzle-orm'
import type { PgTableWithColumns } from 'drizzle-orm/pg-core'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { FilterDescriptor } from './operators'
import { getTableName, getTableColumns } from 'drizzle-orm'

// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle DB instance type varies by driver; no common typed interface
type DrizzleDb = any
// oxlint-disable-next-line typescript/no-explicit-any -- PgTableWithColumns requires a config generic; any is needed for polymorphic table usage
type AnyTable = PgTableWithColumns<any>

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
  from<T extends AnyTable>(table: T): SelectBuilder<T>
  into<T extends AnyTable>(table: T): InsertBuilder<T>
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
   * API CONSTRAINT (load-bearing): a NULL in a draft shadow column means "no
   * override for this column", NOT "set this column to NULL". A draft therefore
   * cannot clear a nullable field back to NULL — the canonical value is kept and
   * no error is raised. Deleting a row is expressed via the `__tombstone` flag,
   * not by nulling its columns.
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
  private _clauses: ReadClauses

  constructor(
    table: T,
    db: DrizzleDb,
    tracker: DrizzleTracker,
    clauses: ReadClauses = emptyClauses(),
  ) {
    this._table = table
    this._db = db
    this._tracker = tracker
    this._clauses = clauses
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
    return new SelectBuilder<T, TNext>(this._table, this._db, this._tracker, {
      ...this._clauses,
      ...patch,
    })
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

  limit(n: number): SelectBuilder<T, TRow> {
    return this._with({ limitVal: n })
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  private _buildConditions(columns: Record<string, any>) {
    return this._clauses.filters.map((f) =>
      drizzleOpMap[f.op](requireColumn(columns, f.column), f.value),
    )
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
    this._tracker.tablesRead.add(getTableName(this._table))
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
   */
  toSql(): Query {
    return this._buildSelectQuery().toSQL()
  }

  async first(): Promise<TRow | null> {
    const rows = await this._read(1)
    return rows[0] ?? null
  }

  async update(values: Partial<T['$inferInsert']>) {
    assertNoReadClauses('update', this._clauses)
    this._tracker.tablesWritten.add(getTableName(this._table))
    let q = this._db.update(this._table).set(values)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const conditions = this._buildConditions(getTableColumns(this._table) as Record<string, any>)
    if (conditions.length > 0) {
      q = q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    }
    return q.returning()
  }

  async delete() {
    assertNoReadClauses('delete', this._clauses)
    this._tracker.tablesWritten.add(getTableName(this._table))
    let q = this._db.delete(this._table)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const conditions = this._buildConditions(getTableColumns(this._table) as Record<string, any>)
    if (conditions.length > 0) {
      q = q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    }
    return q.returning()
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
 * READ side (`.all()` / `.first()`): a SINGLE `where(eq(pk, value))` IS pushed
 * into the coalesce SQL as a bound `AND COALESCE(d."<pk>", b."<pk>") = $value`
 * predicate — this is the exact shape every command handler emits
 * (`from(t).where(eq('id', x)).first()`), so a handler reads its row unmodified
 * inside a draft. Any OTHER read filter shape (a non-`eq` op, a non-PK column,
 * or more than one filter) THROWS, so a caller can never believe a draft read
 * was row-filtered when it was not (an auth/authz hazard). An UNFILTERED `.all()`
 * returns the full coalesced set, as before.
 *
 * `orderBy`/`limit` are pushed into the coalesce SQL, ordering on the COALESCED
 * value so draft-inserted rows sort by what the draft holds, with the PK kept as
 * a tiebreaker (a FULL OUTER JOIN has no inherent row order).
 *
 * WRITE side (`.where(eqPk).update(vals)` / `.where(eqPk).delete()`): routes the
 * mutation into the `<table>__draft` shadow as a sparse upsert (update) or
 * tombstone (delete), keyed `(draft_id, <pk>)`. The `where` MUST pin the primary
 * key with an `eq` (the only shape a command handler emits); any other filter
 * shape throws. This is the write path that makes an unmodified command handler
 * land in the draft overlay.
 */
export class DraftSelectBuilder<T extends AnyTable> {
  private _table: T
  private _db: DrizzleDb
  private _draftId: string
  private _tracker: DraftDrizzleTracker
  // `_clauses.filters` accumulates `where()` predicates; the consuming method
  // decides intent:
  //   - READ (`all`/`first`) interprets a single PK `eq` as a row predicate
  //     pushed into the coalesce SQL (any other shape throws).
  //   - WRITE (`update`/`delete`) interprets a single PK `eq` as the write
  //     target via `_requirePkFilter` (any other shape throws).
  // The same accumulated filter serves both; only the consumer differs.
  private _clauses: ReadClauses

  constructor(
    table: T,
    db: DrizzleDb,
    draftId: string,
    tracker: DraftDrizzleTracker,
    clauses: ReadClauses = emptyClauses(),
  ) {
    this._table = table
    this._db = db
    this._draftId = draftId
    this._tracker = tracker
    this._clauses = clauses
  }

  /** Copy carrying `patch`. See `SelectBuilder._with` for why no clause method
   *  assigns to `this`. */
  private _with(patch: Partial<ReadClauses>): DraftSelectBuilder<T> {
    return new DraftSelectBuilder<T>(this._table, this._db, this._draftId, this._tracker, {
      ...this._clauses,
      ...patch,
    })
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
    return this._with({ limitVal: n })
  }

  /**
   * Sparse cell-edit into the shadow: upsert `(draft_id, <pk>)` setting ONLY the
   * columns present in `values` (+ `__tombstone = false`), so a draft update of
   * one field does not clobber other fields. Mirrors the canonical
   * `from(t).where(eq('id', x)).update(vals)` shape a command handler emits, but
   * the write lands in `<table>__draft`, not the canonical table.
   *
   * The `where` must pin the primary key with a single `eq`. Returns the upserted
   * shadow rows (Drizzle `.returning()` shape) for parity with the canonical
   * builder.
   *
   * Note what those shadow rows are, because it is why `select` cannot narrow
   * them: a shadow row is the sparse OVERRIDE, where NULL means "not edited"
   * rather than "the value is NULL". Projecting it would answer `{title: null}`
   * for a row whose coalesced title is real — a wrong answer, not a narrower
   * one. Hence the guard rejects rather than honors.
   */
  async update(values: Partial<T['$inferInsert']>): Promise<Record<string, unknown>[]> {
    // Same guard as the canonical builder, which is the point: handlers cannot
    // see which handle they hold.
    assertNoReadClauses('update', this._clauses)
    const pkValue = this._requirePkFilter('update')
    return writeShadowRow(this._db, this._tracker, this._table, this._draftId, {
      pkValue,
      values: values as Record<string, unknown>,
      tombstone: false,
    })
  }

  /**
   * Tombstone the row in the shadow: upsert `(draft_id, <pk>, __tombstone=true)`
   * so the coalesce read suppresses it. Mirrors the canonical
   * `from(t).where(eq('id', x)).delete()` a command handler emits.
   *
   * The `where` must pin the primary key with a single `eq`.
   */
  async delete(): Promise<Record<string, unknown>[]> {
    assertNoReadClauses('delete', this._clauses)
    const pkValue = this._requirePkFilter('delete')
    return writeShadowRow(this._db, this._tracker, this._table, this._draftId, {
      pkValue,
      values: {},
      tombstone: true,
    })
  }

  /**
   * Extract the single primary-key value the write targets from the accumulated
   * `where` filters. A draft write must address exactly one row by PK — the only
   * shape a command handler emits (`where(eq(pk, value))`). Anything else
   * (no filter, a non-`eq` op, a filter on a non-PK column, multiple filters)
   * throws, because the shadow upsert is PK-keyed and cannot honor a predicate.
   */
  private _requirePkFilter(op: 'update' | 'delete'): unknown {
    const tableName = getTableName(this._table)
    const config = getTableConfig(this._table)
    const pkColName = resolvePkColumnName(this._table, config)
    // Map the PK SQL column name back to its Drizzle property key, since filters
    // are expressed against property keys (e.g. `eq('id', x)`).
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const pkPropKey = Object.keys(columns).find((k) => (columns[k].name as string) === pkColName)

    if (this._clauses.filters.length !== 1) {
      throw new Error(
        `DraftSelectBuilder.${op}() requires exactly one \`where(eq('${pkPropKey ?? pkColName}', value))\` ` +
          `filter pinning the primary key — got ${this._clauses.filters.length}. A draft write addresses ` +
          `a single row by PK (it cannot honor a general predicate against the shadow).`,
      )
    }
    const f = this._clauses.filters[0]
    if (f.op !== 'eq' || (f.column !== pkPropKey && f.column !== pkColName)) {
      throw new Error(
        `DraftSelectBuilder.${op}() requires \`where(eq('${pkPropKey ?? pkColName}', value))\` on table ` +
          `"${tableName}" — got \`${f.op}('${f.column}', …)\`. Draft writes are PK-addressed only.`,
      )
    }
    return f.value
  }

  /**
   * Resolve the single PK `eq` value the READ coalesce should pin, from the
   * accumulated `where` filters. Returns `{ present: false }` when no filter was
   * set (an unfiltered full-set read). When exactly one filter is present it MUST
   * be an `eq` on the PK column (prop-key or sql-col-name form) with a defined,
   * non-null value — the only shape a command handler emits
   * (`where(eq('id', x)).first()`). Anything else (a non-`eq` op, a non-PK
   * column, 2+ filters, or a PK pinned to `undefined`/`null`) THROWS rather than
   * silently returning every row — a filtered-but-unfiltered draft read is an
   * auth/authz hazard.
   *
   * Presence is keyed on filter COUNT, not on the resolved value: a falsy-but-
   * valid PK (`0`, `''`) must still pin. `undefined`/`null` are rejected loud —
   * binding them would either widen to the full set (`undefined` → no predicate)
   * or fail closed inconsistently (`= NULL` → 0 rows); a handler reading by an
   * absent id is a bug, not a request for every row. Mirrors `_requirePkFilter`
   * (the write path) so read and write reject the same shapes identically.
   */
  private _resolvePkReadFilter(
    pkColName: string,
  ): { present: false } | { present: true; value: unknown } {
    if (this._clauses.filters.length === 0) return { present: false }

    const tableName = getTableName(this._table)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const pkPropKey = Object.keys(columns).find((k) => (columns[k].name as string) === pkColName)

    if (this._clauses.filters.length !== 1) {
      throw new Error(
        `DraftSelectBuilder.all()/first() after .where() supports exactly one ` +
          `\`where(eq('${pkPropKey ?? pkColName}', value))\` pinning the primary key — got ` +
          `${this._clauses.filters.length} filters. The draft read coalesce can only push a single PK ` +
          `predicate down (a general predicate is not supported — it would silently return every row).`,
      )
    }
    const f = this._clauses.filters[0]
    if (f.op !== 'eq' || (f.column !== pkPropKey && f.column !== pkColName)) {
      throw new Error(
        `DraftSelectBuilder.all()/first() after .where() requires ` +
          `\`where(eq('${pkPropKey ?? pkColName}', value))\` on table "${tableName}" — got ` +
          `\`${f.op}('${f.column}', …)\`. A draft read can only be pinned by the primary key.`,
      )
    }
    if (f.value === undefined || f.value === null) {
      throw new Error(
        `DraftSelectBuilder.all()/first() after .where() got ` +
          `\`where(eq('${pkPropKey ?? pkColName}', ${String(f.value)}))\` — a primary-key read ` +
          `pinned to ${String(f.value)} is rejected (it would otherwise silently return every ` +
          `coalesced row). Pass a defined PK value.`,
      )
    }
    return { present: true, value: f.value }
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
    const tableName = getTableName(this._table)
    const draftTableName = `${tableName}__draft`

    // Record the base table read AND the shadow-table read. The draft read's
    // result genuinely depends on `<table>__draft`: a write to it (e.g.
    // `into(todosDraft).insert(...)` publishing tablesWritten={'todos__draft'})
    // must invalidate this subscription, which only happens if the shadow table
    // is in tablesRead so the reactive router's read∩write intersection fires.
    this._tracker.tablesRead.add(tableName)
    this._tracker.tablesRead.add(draftTableName)

    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const colEntries = Object.entries(columns)

    // Single getTableConfig() read shared by PK resolution + schema qualification.
    const config = getTableConfig(this._table)
    const pkColName = resolvePkColumnName(this._table, config)

    // Resolve an optional single-PK read predicate from `where()`. No filter
    // → unfiltered full-set read (as before). A present filter → push
    // `AND COALESCE(d."<pk>", b."<pk>") = $value` into the WHERE as a bound
    // param. Any non-PK / non-`eq` / multi-filter / null-pinned shape throws
    // inside the resolver (an auth/authz hazard if silently dropped). Presence
    // is a discriminated flag keyed on the filter, NOT on the value — a falsy
    // PK (`0`, `''`) must still pin. The value is routed through the PK column
    // codec so it binds identically to the write path.
    const pkFilter = this._resolvePkReadFilter(pkColName)
    const pkCol = Object.values(columns).find((c) => (c.name as string) === pkColName)
    const pkFilterValue = pkFilter.present
      ? pkCol
        ? mapColumnValue(pkCol, pkFilter.value)
        : pkFilter.value
      : undefined

    // Schema-qualify both relations when the table lives outside the default
    // schema (pgSchema('app').table(...)). Canonical Drizzle selects emit the
    // schema prefix; the raw coalesce SQL must match or it reads the wrong
    // relation / fails with relation-not-found.
    const schema = config.schema
    const baseRel = schema ? `"${schema}"."${tableName}"` : `"${tableName}"`
    const draftRel = schema ? `"${schema}"."${draftTableName}"` : `"${draftTableName}"`

    // Build: COALESCE(d."sql_col", b."sql_col") AS "propertyKey" for every column.
    //
    // The JOIN/COALESCE operate on the SQL column name (col.name), but the
    // result is aliased to the Drizzle PROPERTY KEY so the returned row shape is
    // byte-identical to canonical `from().all()`. Without this, a column like
    // `createdAt: timestamp('created_at')` would come back as `created_at` and
    // consumers reading `row.createdAt` would see undefined.
    //
    // Storage convention (load-bearing): NULL in a draft shadow column means
    // "no override for this column" — NOT "set this column to NULL". Setting a
    // nullable column to NULL via a draft is therefore not supported by this
    // primitive. The `__tombstone` flag is the only way to delete a row.
    // This convention must be enforced by the schema (shadow columns default to NULL,
    // tombstone = true captures deletes). Column-drift (base schema evolves under an
    // old draft) is out of scope — see PR body.
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
        return `COALESCE(d."${sqlName}", b."${sqlName}") AS "${propKey}"`
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
    const joinAndTombstone = sql.raw(
      `) d ON b."${pkColName}" = d."${pkColName}" ` +
        `WHERE COALESCE(d."__tombstone", false) = false`,
    )
    // The pk order is both the default and, when a caller names a column, the
    // trailing tiebreaker — see `orderBy` for why it is never dropped.
    const pkOrder = `COALESCE(d."${pkColName}", b."${pkColName}")`
    let orderByClause = ` ORDER BY ${pkOrder}`
    if (this._clauses.orderByCol !== undefined) {
      // `!== undefined`, not truthiness, and the same test the write guard uses:
      // when the two disagreed, `orderBy('')` produced an unordered read the
      // caller believed was sorted while still blocking a later write. The empty
      // name is now rejected in the setter; this stays aligned regardless.
      const col = requireColumn(columns, this._clauses.orderByCol)
      const sqlName = col.name as string
      const dir = this._clauses.orderDir === 'desc' ? ' DESC' : ''
      orderByClause = ` ORDER BY COALESCE(d."${sqlName}", b."${sqlName}")${dir}, ${pkOrder}`
    }
    const orderBy = sql.raw(orderByClause)
    // Bound param, not interpolated — the value is caller-supplied.
    const limitVal = limitOverride ?? this._clauses.limitVal
    const limit = limitVal === undefined ? sql.raw('') : sql`${sql.raw(' LIMIT ')}${limitVal}`
    // `present` → bound `AND COALESCE(...) = $pkFilterValue`; absent → no fragment.
    const pkPredicate = pkFilter.present
      ? sql`${sql.raw(` AND COALESCE(d."${pkColName}", b."${pkColName}") = `)}${pkFilterValue}`
      : sql.raw('')

    // `this._draftId` and `pkFilterValue` are interpolated as bound parameters by
    // the sql tag; relation/column names are introspected identifiers via sql.raw.
    const query = sql`${prefix}${this._draftId}${joinAndTombstone}${pkPredicate}${orderBy}${limit}`

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
   * Coalesced first-row read. Mirrors `SelectBuilder.first()` so an UNMODIFIED
   * handler that calls `ctx.db.from(table).where(eq('id', x)).first()` works
   * inside a draft (the `runHandler` widening hides the structural gap from the
   * typechecker). Shares the coalesce with `all()`, so it honors the SAME
   * single-PK read predicate: `where(eq(pk, x)).first()` returns the one
   * coalesced row (or null); an unfiltered `first()` returns the first row of the
   * full coalesced set in PK order. Any non-PK read filter throws in the shared
   * read, so neither read method can be silently unfiltered.
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
  opts: { pkValue: unknown; values: Record<string, unknown>; tombstone: boolean },
): Promise<Record<string, unknown>[]> {
  const tableName = getTableName(table)
  const draftTableName = `${tableName}__draft`
  const config = getTableConfig(table)
  const pkColName = resolvePkColumnName(table, config)
  const schema = config.schema
  const draftRel = schema ? `"${schema}"."${draftTableName}"` : `"${draftTableName}"`

  tracker.tablesWritten.add(draftTableName)

  // Route the PK value through its column codec too, so a PK whose type has a
  // non-identity codec binds identically to the canonical path. PKs are
  // typically uuid/text/serial (identity codec → no-op), but routing rather than
  // assuming keeps the write path codec-correct for any PK column type.
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  const columns = getTableColumns(table) as Record<string, any>
  const pkCol = Object.values(columns).find((c) => (c.name as string) === pkColName)
  const pkValue = pkCol ? mapColumnValue(pkCol, opts.pkValue) : opts.pkValue

  // Provided value columns (sparse), excluding the PK (carried separately) and
  // any accidental __tombstone / draft_id passthrough (owned by this writer).
  const valueCols = toSqlColumnMap(table, opts.values).filter(
    (c) => c.sqlName !== pkColName && c.sqlName !== '__tombstone' && c.sqlName !== 'draft_id',
  )

  // INSERT column list + bound-parameter VALUES list. Order:
  //   draft_id, <pk>, <provided value cols...>, __tombstone
  const insertCols = ['draft_id', pkColName, ...valueCols.map((c) => c.sqlName), '__tombstone']
  const insertColSql = insertCols.map((c) => `"${c}"`).join(', ')

  // ON CONFLICT (draft_id, <pk>) DO UPDATE: only the provided value cols +
  // __tombstone. (A tombstone with no value cols just flips __tombstone.)
  const updateAssignments = [
    ...valueCols.map((c) => `"${c.sqlName}" = EXCLUDED."${c.sqlName}"`),
    `"__tombstone" = EXCLUDED."__tombstone"`,
  ].join(', ')

  // Assemble parameterized VALUES. Every dynamic value is a bound param; column
  // and relation names are introspected identifiers spliced via sql.raw.
  const head = sql.raw(`INSERT INTO ${draftRel} (${insertColSql}) VALUES (`)
  const parts: ReturnType<typeof sql>[] = [head, sql`${draftId}`, sql.raw(', '), sql`${pkValue}`]
  for (const c of valueCols) {
    parts.push(sql.raw(', '), sql`${c.value}`)
  }
  parts.push(sql.raw(', '), sql`${opts.tombstone}`)
  parts.push(
    sql.raw(
      `) ON CONFLICT ("draft_id", "${pkColName}") DO UPDATE SET ${updateAssignments} RETURNING *`,
    ),
  )
  const query = sql.join(parts, sql.raw(''))

  const result = await db.execute(query)
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

  constructor(table: T, db: DrizzleDb, draftId: string, tracker: DraftDrizzleTracker) {
    this._table = table
    this._db = db
    this._draftId = draftId
    this._tracker = tracker
  }

  async insert(
    values: T['$inferInsert'] | T['$inferInsert'][],
  ): Promise<Record<string, unknown>[]> {
    const rows = Array.isArray(values) ? values : [values]
    const config = getTableConfig(this._table)
    const pkColName = resolvePkColumnName(this._table, config)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const pkPropKey = Object.keys(columns).find((k) => (columns[k].name as string) === pkColName)

    const out: Record<string, unknown>[] = []
    for (const row of rows) {
      const r = row as Record<string, unknown>
      const pkValue = pkPropKey !== undefined ? r[pkPropKey] : r[pkColName]
      if (pkValue === undefined || pkValue === null) {
        throw new Error(
          `DraftInsertBuilder.insert(): row is missing primary key "${pkPropKey ?? pkColName}". ` +
            `Draft inserts require a client-minted PK so the shadow row is addressable.`,
        )
      }
      // Pass the full row as sparse values; writeShadowRow drops the PK column
      // (carried separately) and any reserved shadow columns.
      const written = await writeShadowRow(this._db, this._tracker, this._table, this._draftId, {
        pkValue,
        values: r,
        tombstone: false,
      })
      out.push(...written)
    }
    return out
  }
}

export class InsertBuilder<T extends AnyTable> {
  private _table: T
  private _db: DrizzleDb
  private _tracker: DrizzleTracker

  constructor(table: T, db: DrizzleDb, tracker: DrizzleTracker) {
    this._table = table
    this._db = db
    this._tracker = tracker
  }

  async insert(values: T['$inferInsert'] | T['$inferInsert'][]) {
    this._tracker.tablesWritten.add(getTableName(this._table))
    const rows = Array.isArray(values) ? values : [values]
    return this._db.insert(this._table).values(rows).returning()
  }
}

export function createDrizzleTracker(drizzleDb: DrizzleDb): DrizzleTracker {
  const tracker: DrizzleTracker = {
    tablesRead: new Set(),
    tablesWritten: new Set(),
    raw: drizzleDb,
    from<T extends AnyTable>(table: T) {
      return new SelectBuilder(table, drizzleDb, tracker)
    },
    into<T extends AnyTable>(table: T) {
      return new InsertBuilder(table, drizzleDb, tracker)
    },
    withDraft(draftId: string): DraftDrizzleTracker {
      const draftHandle: DraftDrizzleTracker = {
        tablesRead: tracker.tablesRead,
        tablesWritten: tracker.tablesWritten,
        raw: drizzleDb,
        from<T extends AnyTable>(table: T) {
          return new DraftSelectBuilder(table, drizzleDb, draftId, draftHandle)
        },
        into<T extends AnyTable>(table: T) {
          return new DraftInsertBuilder(table, drizzleDb, draftId, draftHandle)
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
        inner = createDrizzleTracker(txHandle)
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
  return createDrizzleTracker(tracked.raw)
}
