/**
 * TrackedDb — fluent query builder wrapping Drizzle that auto-records
 * tablesRead / tablesWritten for reactive invalidation.
 */
import { eq as drizzleEq, ne as drizzleNe, gt as drizzleGt, gte as drizzleGte, lt as drizzleLt, lte as drizzleLte, asc, desc } from 'drizzle-orm'
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

export interface TrackedDb {
  tablesRead: Set<string>
  tablesWritten: Set<string>
  /** Raw Drizzle instance for complex queries (joins, raw SQL). Caller must manually
   *  record table reads/writes for reactive tracking to work. */
  raw: DrizzleDb
  from<T extends AnyTable>(table: T): SelectBuilder<T>
  into<T extends AnyTable>(table: T): InsertBuilder<T>
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
    this._filters = [...this._filters, ...toAdd]
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

  private _buildConditions() {
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
    return this._filters.map(f => {
      const col = columns[f.column]
      if (!col) throw new Error(`Unknown column: ${f.column}`)
      return drizzleOpMap[f.op](col, f.value)
    })
  }

  async all() {
    this._tracker.tablesRead.add(getTableName(this._table))
    let q = this._db.select().from(this._table)

    const conditions = this._buildConditions()
    for (const cond of conditions) {
      q = q.where(cond)
    }

    if (this._orderByCol) {
      // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    const columns = getTableColumns(this._table) as Record<string, any>
      const col = columns[this._orderByCol]
      if (col) {
        q = q.orderBy(this._orderDir === 'desc' ? desc(col) : asc(col))
      }
    }

    if (this._limitVal !== undefined) {
      q = q.limit(this._limitVal)
    }

    return q
  }

  async first() {
    this._limitVal = 1
    const rows = await this.all()
    return rows[0] ?? null
  }

  async update(values: Partial<T['$inferInsert']>) {
    this._tracker.tablesWritten.add(getTableName(this._table))
    let q = this._db.update(this._table).set(values)
    const conditions = this._buildConditions()
    for (const cond of conditions) {
      q = q.where(cond)
    }
    return q.returning()
  }

  async delete() {
    this._tracker.tablesWritten.add(getTableName(this._table))
    let q = this._db.delete(this._table)
    const conditions = this._buildConditions()
    for (const cond of conditions) {
      q = q.where(cond)
    }
    return q.returning()
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
  }
  return tracker
}

/** Create a fresh TrackedDb that shares the same Drizzle connection but resets tracking sets */
export function resetTracking(tracked: TrackedDb): TrackedDb {
  tracked.tablesRead.clear()
  tracked.tablesWritten.clear()
  return tracked
}
