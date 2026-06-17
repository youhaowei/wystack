/**
 * TrackedDb — fluent query builder wrapping Drizzle that auto-records
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
import type { PgTableWithColumns } from 'drizzle-orm/pg-core'
import type { FilterDescriptor } from './operators'
import { getTableName, getTableColumns } from 'drizzle-orm'

// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle DB instance type varies by driver; no common typed interface
type DrizzleDb = any
// oxlint-disable-next-line typescript/no-explicit-any -- PgTableWithColumns requires a config generic; any is needed for polymorphic table usage
type AnyTable = PgTableWithColumns<any>

const drizzleOpMap = {
  eq: drizzleEq,
  ne: drizzleNe,
  gt: drizzleGt,
  gte: drizzleGte,
  lt: drizzleLt,
  lte: drizzleLte,
} as const

/**
 * A read-focused handle returned by `withDraft(draftId)`. Exposes the same
 * read surface as `TrackedDb` but `from()` returns a draft-coalescing builder.
 * Write methods (`into`, `transaction`) are intentionally omitted — draft reads
 * are a separate entry point and do not participate in write transactions.
 */
export interface DraftTrackedDb {
  tablesRead: Set<string>
  tablesWritten: Set<string>
  /** Raw Drizzle instance, same as `TrackedDb.raw`. */
  raw: DrizzleDb
  from<T extends AnyTable>(table: T): DraftSelectBuilder<T>
}

export interface TrackedDb {
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
   * `fn` receives a fresh TrackedDb bound to the native transaction handle. On
   * commit (fn resolves) the inner reads/writes merge into this tracker's sets,
   * so a successful batch's write Tags flush to invalidation as one set. On
   * rollback (fn throws, or `tx.raw.rollback()`) the merge is skipped and the
   * transaction emits nothing.
   *
   * This rollback-emits-nothing property is what preview's execute-then-rollback
   * builds on, but preview is not fully served by this signature alone: rollback
   * only happens via a throw, which destroys the `R` return channel — a preview
   * that must roll back *and* return a diff has to smuggle the diff through a
   * thrown sentinel. The diff-returning preview contract is YW-124's to design;
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
  transaction<R>(fn: (tx: TrackedDb) => Promise<R>, opts?: TransactionOptions): Promise<R>
  /**
   * Return a draft-coalescing read handle for the given draft ID.
   *
   * `handle.from(table).all()` executes a FULL OUTER JOIN coalesce between the
   * base table and its `<table>__draft` shadow, applying delta edits, surfacing
   * draft inserts, and suppressing tombstoned rows — all without touching the
   * canonical `from().all()` code path. A no-draft read is structurally
   * zero-overhead: it never reaches the coalesce logic.
   */
  withDraft(draftId: string): DraftTrackedDb
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

export class SelectBuilder<T extends AnyTable> {
  private _table: T
  private _db: DrizzleDb
  private _tracker: TrackedDb
  private _filters: FilterDescriptor[] = []
  private _orderByCol?: string
  private _orderDir: 'asc' | 'desc' = 'asc'
  private _limitVal?: number

  constructor(table: T, db: DrizzleDb, tracker: TrackedDb) {
    this._table = table
    this._db = db
    this._tracker = tracker
  }

  where(filters: FilterDescriptor | FilterDescriptor[]) {
    const toAdd = Array.isArray(filters) ? filters : [filters]
    this._filters.push(...toAdd)
    return this
  }

  orderBy(col: string, dir: 'asc' | 'desc' = 'asc') {
    this._orderByCol = col
    this._orderDir = dir
    return this
  }

  limit(n: number) {
    this._limitVal = n
    return this
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
  private _buildConditions(columns: Record<string, any>) {
    return this._filters.map((f) => {
      const col = columns[f.column]
      if (!col) throw new Error(`Unknown column: ${f.column}`)
      return drizzleOpMap[f.op](col, f.value)
    })
  }

  async all() {
    this._tracker.tablesRead.add(getTableName(this._table))
    let q = this._db.select().from(this._table)

    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const conditions = this._buildConditions(columns)
    if (conditions.length > 0) {
      q = q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    }

    if (this._orderByCol) {
      const col = columns[this._orderByCol]
      if (!col) throw new Error(`Unknown column: ${this._orderByCol}`)
      q = q.orderBy(this._orderDir === 'desc' ? desc(col) : asc(col))
    }

    if (this._limitVal !== undefined) {
      q = q.limit(this._limitVal)
    }

    return q
  }

  /**
   * Return the lowered SQL without executing. Used in tests to assert that the
   * canonical read path generates byte-identical SQL when no draft is active —
   * i.e., zero-overhead is structural, not conditional.
   */
  toSql() {
    let q = this._db.select().from(this._table)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const conditions = this._buildConditions(columns)
    if (conditions.length > 0) {
      q = q.where(conditions.length === 1 ? conditions[0] : and(...conditions))
    }
    if (this._orderByCol) {
      const col = columns[this._orderByCol]
      if (!col) throw new Error(`Unknown column: ${this._orderByCol}`)
      q = q.orderBy(this._orderDir === 'desc' ? desc(col) : asc(col))
    }
    if (this._limitVal !== undefined) {
      q = q.limit(this._limitVal)
    }
    return q.toSQL()
  }

  async first() {
    this._limitVal = 1
    const rows = await this.all()
    return rows[0] ?? null
  }

  async update(values: Partial<T['$inferInsert']>) {
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
 * Draft-coalescing select builder returned by `DraftTrackedDb.from()`.
 *
 * `all()` executes a FULL OUTER JOIN between the base table and its
 * `<table>__draft` shadow, coalescing every column so that draft edits win
 * over canonical values, draft inserts appear, and tombstoned rows are
 * excluded.
 *
 * The draft table name is derived automatically: `<base_table>__draft`.
 * No application-specific mapping is required.
 *
 * `where()`, `orderBy()`, and `limit()` are accepted for API symmetry with
 * `SelectBuilder` but are NOT yet applied inside the coalesce SQL.
 * TODO: where/orderBy/limit not yet applied inside draft coalesce (YW-120 scope is the primitive only)
 */
export class DraftSelectBuilder<T extends AnyTable> {
  private _table: T
  private _db: DrizzleDb
  private _draftId: string
  private _tracker: DraftTrackedDb

  constructor(table: T, db: DrizzleDb, draftId: string, tracker: DraftTrackedDb) {
    this._table = table
    this._db = db
    this._draftId = draftId
    this._tracker = tracker
  }

  where(_filters: FilterDescriptor | FilterDescriptor[]): this {
    // where/orderBy/limit are not yet applied inside the draft coalesce SQL.
    // Callers must not rely on these for row-level filtering (including auth/authz)
    // until implemented. Throw loudly to prevent silent filter bypass.
    throw new Error(
      'DraftSelectBuilder.where() is not yet implemented (YW-120 scope: coalesce primitive only). ' +
        'Do not use .where() on a draft handle for row-level filtering.',
    )
  }

  orderBy(_col: string, _dir: 'asc' | 'desc' = 'asc'): this {
    throw new Error(
      'DraftSelectBuilder.orderBy() is not yet implemented (YW-120 scope: coalesce primitive only).',
    )
  }

  limit(_n: number): this {
    throw new Error(
      'DraftSelectBuilder.limit() is not yet implemented (YW-120 scope: coalesce primitive only).',
    )
  }

  async all(): Promise<Record<string, unknown>[]> {
    const tableName = getTableName(this._table)
    this._tracker.tablesRead.add(tableName)

    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    const colValues = Object.values(columns)

    // Determine the primary key column (single pass: prefer explicit pk, fall back to 'id').
    // `col.primary` is the PgColumn flag set by `.primaryKey()` in drizzle-orm/pg-core.
    const pkCol =
      colValues.find((c) => c.primary === true) ??
      colValues.find((c) => (c.name as string) === 'id')
    if (!pkCol) {
      throw new Error(
        `DraftSelectBuilder: table "${tableName}" has no primary key column and no column named "id". ` +
          `Cannot build draft coalesce query.`,
      )
    }
    const pkColName = pkCol.name as string

    const draftTableName = `${tableName}__draft`

    // Build: COALESCE(d."col", b."col") AS "col" for every base-table column.
    //
    // Storage convention (load-bearing): NULL in a draft shadow column means
    // "no override for this column" — NOT "set this column to NULL". Setting a
    // nullable column to NULL via a draft is therefore not supported by this
    // primitive. The `__tombstone` flag is the only way to delete a row.
    // This convention must be enforced by the schema (shadow columns default to NULL,
    // tombstone = true captures deletes). Column-drift (base schema evolves under an
    // old draft) is out of scope — see PR body.
    const colSelects = colValues
      .map((col) => {
        const sqlName = col.name as string
        return `COALESCE(d."${sqlName}", b."${sqlName}") AS "${sqlName}"`
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
        `FROM "${tableName}" b ` +
        `FULL OUTER JOIN (SELECT * FROM "${draftTableName}" WHERE "draft_id" = `,
    )
    const suffix = sql.raw(
      `) d ON b."${pkColName}" = d."${pkColName}" ` +
        `WHERE COALESCE(d."__tombstone", false) = false ` +
        `ORDER BY COALESCE(d."${pkColName}", b."${pkColName}")`,
    )
    // `this._draftId` is interpolated as a bound parameter by the sql tag.
    const query = sql`${prefix}${this._draftId}${suffix}`

    const result = await this._db.execute(query)
    // db.execute returns { rows: [...], fields: [...], affectedRows: number }
    return (result as { rows: Record<string, unknown>[] }).rows
  }
}

export class InsertBuilder<T extends AnyTable> {
  private _table: T
  private _db: DrizzleDb
  private _tracker: TrackedDb

  constructor(table: T, db: DrizzleDb, tracker: TrackedDb) {
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

export function createTrackedDb(drizzleDb: DrizzleDb): TrackedDb {
  const tracker: TrackedDb = {
    tablesRead: new Set(),
    tablesWritten: new Set(),
    raw: drizzleDb,
    from<T extends AnyTable>(table: T) {
      return new SelectBuilder(table, drizzleDb, tracker)
    },
    into<T extends AnyTable>(table: T) {
      return new InsertBuilder(table, drizzleDb, tracker)
    },
    withDraft(draftId: string): DraftTrackedDb {
      const draftHandle: DraftTrackedDb = {
        tablesRead: tracker.tablesRead,
        tablesWritten: tracker.tablesWritten,
        raw: drizzleDb,
        from<T extends AnyTable>(table: T) {
          return new DraftSelectBuilder(table, drizzleDb, draftId, draftHandle)
        },
      }
      return draftHandle
    },
    async transaction<R>(fn: (tx: TrackedDb) => Promise<R>, opts?: TransactionOptions): Promise<R> {
      // The lowering owns atomicity: Drizzle's native transaction provides the
      // tx handle and commits/rolls back. We add Tag-tracking by wrapping that
      // handle in a fresh TrackedDb. If `fn` throws, calls rollback, or the
      // COMMIT itself fails, the native transaction rejects this await before
      // the merge below runs — so a non-committed transaction merges nothing
      // and emits no Tags. The merge-after-await placement IS the guarantee;
      // there is deliberately no `committed` flag to drift out of sync.
      let inner: TrackedDb | undefined
      const result = await drizzleDb.transaction(async (txHandle: DrizzleDb) => {
        inner = createTrackedDb(txHandle)
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

/** Create a fresh TrackedDb that shares the same Drizzle connection but with empty tracking sets */
export function resetTracking(tracked: TrackedDb): TrackedDb {
  return createTrackedDb(tracked.raw)
}
