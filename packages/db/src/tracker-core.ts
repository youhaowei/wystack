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
  sql,
} from 'drizzle-orm'
import type { Query } from 'drizzle-orm'
import type { PgTableWithColumns } from 'drizzle-orm/pg-core'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { FilterDescriptor } from './operators'
import { getTableName, getTableColumns } from 'drizzle-orm'
import { tryGetTableCapabilities } from './schema'
import type { SelectBuilder } from './select-builder'
import type { DraftSelectBuilder } from './draft-select-builder'
import type { DraftInsertBuilder } from './draft-mutations'
import type { InsertBuilder } from './tracker-factory'
import type { SystemManagedProperties } from './table'
import { mapColumnValue, normalizeExecuteRows } from './tracker-codecs'
import { canonicalizeIdentity } from './identity-codec'

// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle DB instance type varies by driver; no common typed interface
export type DrizzleDb = any
// oxlint-disable-next-line typescript/no-explicit-any -- PgTableWithColumns requires a config generic; any is needed for polymorphic table usage
export type AnyTable = PgTableWithColumns<any>

type WithoutSystemManagedProperties<TTable, TValues> = Omit<
  TValues,
  SystemManagedProperties<TTable>
> & {
  [TProperty in SystemManagedProperties<TTable>]?: never
}

/** Values an application may provide to a tracked insert. */
export type TrackedInsertValues<T extends AnyTable> = WithoutSystemManagedProperties<
  T,
  T['$inferInsert']
>

/** Sparse values an application may provide to a tracked update. */
export type TrackedUpdateValues<T extends AnyTable> = Partial<TrackedInsertValues<T>>

export const draftChangesRelation = '"wystack_draft_row_changes"'
const draftJsonNullMarker = Symbol('wystack draft JSON null')

/** Explicit JSON `null` for a tracked json/jsonb write. Plain `null` remains SQL NULL. */
export interface DraftJsonNull {
  readonly [draftJsonNullMarker]: true
}

export function jsonNull(): DraftJsonNull {
  return Object.freeze({ [draftJsonNullMarker]: true as const })
}

export interface DraftRowChange {
  draftId: string
  tableKey: string
  tenantKey: unknown
  rowKey: unknown
  operation: 'insert' | 'update' | 'delete'
  baseExists: boolean
  baseRevision: unknown
  fields: Record<
    string,
    {
      original: DraftStoredValue
      value: DraftStoredValue
    }
  >
}

export type DraftStoredValue =
  | { kind: 'absent' }
  | { kind: 'sql-null' }
  | { kind: 'json'; value: unknown }
  | { kind: 'value'; value: unknown }

/** One indexed scan for review, conflict classification, rebase, or diagnostics. */
export async function enumerateDraftRowChanges(
  raw: DrizzleDb,
  draftId: string,
): Promise<DraftRowChange[]> {
  const result = await raw.execute(sql`
    SELECT draft_id, table_key, tenant_key, row_key, operation,
           base_exists, base_revision, fields
    FROM wystack_draft_row_changes
    WHERE draft_id = ${draftId}
    ORDER BY table_key, tenant_key_text, row_key_text
  `)
  return normalizeExecuteRows(result).map((row) => ({
    draftId: String(row['draft_id']),
    tableKey: String(row['table_key']),
    tenantKey: decodeJsonDriverValue(row['tenant_key']),
    rowKey: decodeJsonDriverValue(row['row_key']),
    operation: String(row['operation']) as DraftRowChange['operation'],
    baseExists: Boolean(row['base_exists']),
    baseRevision: decodeJsonDriverValue(row['base_revision']),
    fields: decodeJsonDriverValue(row['fields']) as DraftRowChange['fields'],
  }))
}

export const noTenantScope = Symbol('no tenant scope')
export type TenantScope = unknown | typeof noTenantScope

export function requireTenantScope(table: AnyTable, tenantScope: TenantScope) {
  const tenancy = tryGetTableCapabilities(table)?.tenancy
  if (!tenancy) return undefined
  if (tenantScope === noTenantScope) {
    throw new Error(
      `Table "${getTableName(table)}" requires tenant scope; call withTenant() with a trusted tenant ID`,
    )
  }
  return { tenancy, tenantId: tenantScope }
}

export function assertDraftWriteScope(table: AnyTable, tenantScope: TenantScope): void {
  const tenancy = tryGetTableCapabilities(table)?.tenancy
  if (tenancy) {
    requireTenantScope(table, tenantScope)
    return
  }
  if (tenantScope !== noTenantScope) {
    throw new Error(`Tenant-scoped drafts cannot write global table "${getTableName(table)}"`)
  }
}

export function assertTenantInput(table: AnyTable, values: Record<string, unknown>): void {
  const tenancy = tryGetTableCapabilities(table)?.tenancy
  if (!tenancy) return
  if (Object.hasOwn(values, tenancy.property) || Object.hasOwn(values, tenancy.column)) {
    throw new Error(
      `Tenant property "${tenancy.property}" is system-managed and cannot be supplied or updated`,
    )
  }
}

// Revision columns are framework-managed compare-and-swap tokens. Application
// writes cannot choose them: inserts allocate a durable row-incarnation token
// and every successful update advances it with the domain change.
export function revisionProperty(table: AnyTable): string | undefined {
  return tryGetTableCapabilities(table)?.revisionProperty
}

/** Framework-owned nullable timestamp used to hide logically removed rows. */
export function softDeleteProperty(table: AnyTable): string | undefined {
  return tryGetTableCapabilities(table)?.softDeleteProperty
}

export function assertRevisionInput(table: AnyTable, values: Record<string, unknown>): void {
  const property = revisionProperty(table)
  if (!property) return
  const columns = getTableColumns(table) as Record<string, { name: string }>
  const column = requireColumn(columns, property)
  if (Object.hasOwn(values, property) || Object.hasOwn(values, column.name)) {
    throw new Error(`Revision property "${property}" is system-managed and cannot be supplied`)
  }
}

export function assertSoftDeleteInput(table: AnyTable, values: Record<string, unknown>): void {
  const property = softDeleteProperty(table)
  if (!property) return
  const columns = getTableColumns(table) as Record<string, { name: string }>
  const column = requireColumn(columns, property)
  if (Object.hasOwn(values, property) || Object.hasOwn(values, column.name)) {
    throw new Error(
      `Soft-delete property "${property}" is system-managed; use softDelete(at) or restore()`,
    )
  }
}

export function requireSoftDeleteProperty(table: AnyTable): string {
  const property = softDeleteProperty(table)
  if (!property) {
    throw new Error(
      `Table "${getTableName(table)}" does not opt into soft deletion; configure a soft-delete property first`,
    )
  }
  return property
}

export function assertValidSoftDeleteTimestamp(at: Date): void {
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new Error('softDelete(at) requires a valid explicit Date')
  }
}

export function withoutUndefined(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined))
}

function qualifiedTableName(table: AnyTable): string {
  const tableName = getTableName(table)
  const schemaName = getTableConfig(table).schema
  return schemaName ? `${schemaName}.${tableName}` : tableName
}

export function tableTrackingTag(table: AnyTable, tenantScope: TenantScope): string {
  const tenant = requireTenantScope(table, tenantScope)
  return publishedInvalidationIdentity(table, tenant?.tenantId)
}

export function draftTableTrackingTag(
  table: AnyTable,
  tenantScope: TenantScope,
  draftId: string,
): string {
  const tenant = requireTenantScope(table, tenantScope)
  return draftInvalidationIdentity(table, draftId, tenant?.tenantId)
}

export function publishedInvalidationIdentity(table: AnyTable, tenantId?: unknown): string {
  const tableName = qualifiedTableName(table)
  const tenancy = tryGetTableCapabilities(table)?.tenancy
  if (!tenancy) return tableName
  if (tenantId === undefined || tenantId === null) {
    throw new Error(`Table "${getTableName(table)}" requires a tenant invalidation identity`)
  }
  const tenantColumn = requireColumn(
    getTableColumns(table) as Record<string, { name: string; getSQLType(): string }>,
    tenancy.property,
  )
  const tenantKey = encodeTypedKey(tenantColumn, tenantId).text
  return `tenant:${encodeURIComponent(tenantKey)}:${tableName}`
}

export function draftInvalidationIdentity(
  table: AnyTable,
  draftId: string,
  tenantId?: unknown,
): string {
  const tableName = qualifiedTableName(table)
  const draft = encodeURIComponent(draftId)
  const tenancy = tryGetTableCapabilities(table)?.tenancy
  if (!tenancy) return `draft:${draft}:${tableName}`
  if (tenantId === undefined || tenantId === null) {
    throw new Error(`Table "${getTableName(table)}" requires a tenant invalidation identity`)
  }
  const tenantColumn = requireColumn(
    getTableColumns(table) as Record<string, { name: string; getSQLType(): string }>,
    tenancy.property,
  )
  const tenantKey = encodeTypedKey(tenantColumn, tenantId).text
  return `tenant:${encodeURIComponent(tenantKey)}:draft:${draft}:${tableName}`
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
export interface LoweredSelect<TRow> extends PromiseLike<TRow[]> {
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
export interface ReadClauses {
  /** Never mutated in place — `where()` REPLACES this array on the copy it
   *  returns. `_with` spreads the clause object, so a `.push` here would write
   *  through to every copy sharing the reference. */
  filters: FilterDescriptor[]
  projection?: string[]
  orderByCol?: string
  orderDir: 'asc' | 'desc'
  limitVal?: number
  /** Active rows by default; callers must explicitly widen tombstone visibility. */
  softDeleteScope: 'active' | 'include' | 'only'
}

/** Fresh state for a builder with nothing attached. A factory, not a shared
 *  constant, so no two builders can ever alias one `filters` array. */
export const emptyClauses = (): ReadClauses => ({
  filters: [],
  orderDir: 'asc',
  softDeleteScope: 'active',
})

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
export function requireColumn(columns: Record<string, any>, name: string) {
  if (!Object.hasOwn(columns, name)) throw new Error(`Unknown column: ${name}`)
  return columns[name]
}

export function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

// `serial` is a DDL shorthand, not a cast target. The overlay needs the real
// canonical type because JSON values cross back into SQL on the small side.
export function draftCastType(column: { getSQLType(): string }): string {
  const type = column.getSQLType().toLowerCase()
  if (type === 'serial') return 'integer'
  if (type === 'bigserial') return 'bigint'
  if (type === 'smallserial') return 'smallint'
  return type
}

export function encodeTypedKey(
  // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle columns
  column: any,
  rawValue: unknown,
): { envelope: unknown; text: string } {
  const type = draftCastType(column)
  const encoded = mapColumnValue(column, rawValue)
  const value = encoded instanceof Date ? encoded.toISOString() : encoded
  const canonical = canonicalizeIdentity(type, value)
  return { envelope: { type, value: canonical.value }, text: canonical.text }
}

function isDraftJsonNull(value: unknown): value is DraftJsonNull {
  return Boolean(
    value && typeof value === 'object' && (value as Partial<DraftJsonNull>)[draftJsonNullMarker],
  )
}

function requireJsonColumn(
  column: { name: string; getSQLType(): string },
  property: string,
): string {
  const type = draftCastType(column)
  if (type !== 'json' && type !== 'jsonb') {
    throw new Error(`jsonNull() can only be assigned to a json or jsonb column, not "${property}"`)
  }
  return type
}

/** Reject explicit JSON-null markers before either tracked write path touches the database. */
export function assertJsonNullInputs(table: AnyTable, values: Record<string, unknown>): void {
  const columns = getTableColumns(table) as Record<string, { name: string; getSQLType(): string }>
  for (const [property, value] of Object.entries(values)) {
    if (!isDraftJsonNull(value)) continue
    requireJsonColumn(requireColumn(columns, property), property)
  }
}

/** Lower the explicit JSON-null marker before a canonical Drizzle write. */
export function materializeJsonNulls(
  table: AnyTable,
  values: Record<string, unknown>,
): Record<string, unknown> {
  assertJsonNullInputs(table, values)
  const columns = getTableColumns(table) as Record<string, { name: string; getSQLType(): string }>
  return Object.fromEntries(
    Object.entries(values).map(([property, value]) => {
      if (!isDraftJsonNull(value)) return [property, value]
      const column = requireColumn(columns, property)
      const type = draftCastType(column)
      return [property, sql.raw(`'null'::${type}`)]
    }),
  )
}

// oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle columns
export function encodeProposedDraftValue(column: any, value: unknown): DraftStoredValue {
  if (value === null) return { kind: 'sql-null' }
  if (isDraftJsonNull(value)) {
    requireJsonColumn(column, String(column.name))
    return { kind: 'json', value: null }
  }
  const type = draftCastType(column)
  if (type === 'json' || type === 'jsonb') return { kind: 'json', value }
  if (type.endsWith('[]') && Array.isArray(value)) {
    // `draftFieldValueSql` rebuilds an array column from a JSON array of
    // elements. Drizzle's array codec would instead produce the PostgreSQL
    // literal (`{"a","b"}`) as one string, which that lowering cannot unpack, so
    // encode each element through the element column's codec and keep the
    // array shape.
    const elements = value.map((element) => {
      const encoded = mapColumnValue(column.baseColumn, element)
      return encoded instanceof Date ? encoded.toISOString() : encoded
    })
    return { kind: 'value', value: elements }
  }
  const encoded = mapColumnValue(column, value)
  return {
    kind: 'value',
    value: encoded instanceof Date ? encoded.toISOString() : encoded,
  }
}

function decodeJsonDriverValue(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** Cast a tagged proposal from the central JSONB row back to a canonical type. */
// oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle columns
export function draftFieldValueSql(column: any, fieldsAlias: string): string {
  const name = column.name as string
  const key = sqlLiteral(name)
  const cast = draftCastType(column)
  const entry = `${fieldsAlias}."fields" -> ${key} -> 'value'`
  if (cast === 'json' || cast === 'jsonb') {
    return `CASE WHEN ${entry} ->> 'kind' = 'sql-null' THEN NULL::${cast} ELSE (${entry} -> 'value')::${cast} END`
  }
  if (cast.endsWith('[]')) {
    const element = cast.slice(0, -2)
    return (
      `CASE WHEN ${entry} ->> 'kind' = 'sql-null' THEN NULL::${cast} ELSE ` +
      `ARRAY(SELECT value::${element} FROM jsonb_array_elements_text(${entry} -> 'value') AS value)::${cast} END`
    )
  }
  return `CASE WHEN ${entry} ->> 'kind' = 'sql-null' THEN NULL::${cast} ELSE (${entry} #>> '{value}')::${cast} END`
}

// oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle columns
export function typedKeyValueSql(alias: string, jsonColumn: string, column: any): string {
  return `(${alias}.${quoteSqlIdentifier(jsonColumn)} #>> '{value}')::${draftCastType(column)}`
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
export function assertNoReadClauses(op: 'update' | 'delete', clauses: ReadClauses): void {
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

export const drizzleOpMap = {
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
 * central `wystack_draft_row_changes` relation rather than the canonical table:
 *
 *   - `from(table).all()`            → coalesced read (canonical ⊕ draft delta)
 *   - `into(table).insert(rows)`     → sparse central change upsert
 *   - `from(table).where(eqPk).update(vals)` → sparse JSONB field edit
 *   - `from(table).where(eqPk).softDelete(at)` / `.restore()` → sparse tombstone edit
 *   - `from(table).where(eqPk).delete()`     → central delete operation
 *
 * The write methods (`into` plus the draft builder's mutation terminals) are what
 * make an EXISTING command handler — which writes via `ctx.db.into(table)` /
 * `ctx.db.from(table).where(...).update(...)` — land in the draft overlay
 * UNMODIFIED when `ctx.db = base.withDraft(draftId)`. The handler is unaware it
 * is writing into a draft.
 *
 * `transaction` is present but THROWS: ProcedureDb intentionally exposes the
 * same facade to canonical and draft handlers, but draft handlers cannot open
 * nested transactions. The lifecycle owns the outer operation boundaries:
 * append commits derived writes with log metadata, and publish commits canonical
 * replay with the derived-state sweep.
 */
export interface DraftDrizzleTracker {
  tablesRead: Set<string>
  tablesWritten: Set<string>
  /** Raw Drizzle instance, same as `DrizzleTracker.raw`. */
  raw: DrizzleDb
  from<T extends AnyTable>(table: T): DraftSelectBuilder<T>
  into<T extends AnyTable>(table: T): DraftInsertBuilder<T>
  /** Always throws — lifecycle operations, not handlers, own draft transactions. */
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
   * slot is the only entry point for them. Framework-owned lifecycle transactions
   * use it when their correctness depends on a specific visibility contract.
   */
  transaction<R>(fn: (tx: DrizzleTracker) => Promise<R>, opts?: TransactionOptions): Promise<R>
  /**
   * Return a draft-coalescing read handle for the given draft ID.
   *
   * `handle.from(table).all()` executes a FULL OUTER JOIN coalesce between the
   * base table and its central JSONB changes, applying delta edits, surfacing
   * draft inserts, and suppressing tombstoned rows — all without touching the
   * canonical `from().all()` code path. A no-draft read is structurally
   * zero-overhead: it never reaches the coalesce logic.
   *
   * Change rows carry sparse `fields` entries with tagged values. A present field
   * overrides canonical even when its proposal is SQL NULL; omitted/undefined
   * leaves it unchanged. Deletion is the row-level `operation = 'delete'`.
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
