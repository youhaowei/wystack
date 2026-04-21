/**
 * syncSchema — idempotent table creation from a compiled schema.
 *
 * For v0.2 dev-mode bootstrap: caller defines its schema via `defineSchema` or
 * raw `pgTable(...)`, then calls `syncSchema(db, schema)` at app boot to
 * materialize tables via `CREATE TABLE IF NOT EXISTS`.
 *
 * ── What it does ─────────────────────────────────────────────────────────
 * - Topologically orders tables by FK dependency (tables with no outgoing FKs
 *   first; tables referencing already-emitted targets next).
 * - Emits `CREATE TABLE IF NOT EXISTS <name> (cols..., PK..., UNIQUE..., FK...)`.
 * - Reads column SQL types, NOT NULL, PRIMARY KEY, UNIQUE, DEFAULT (including
 *   SQL-expression defaults like `gen_random_uuid()`, `now()`), and ARRAY [].
 * - Emits table-level UNIQUE constraints (named) and FOREIGN KEYs with
 *   ON DELETE / ON UPDATE actions.
 *
 * ── What it does NOT do ──────────────────────────────────────────────────
 * - ALTER TABLE — if the schema changes, old tables keep their old shape.
 *   That's a migration concern (drizzle-kit / `wystack migrate` — future).
 * - Index creation (beyond UNIQUE constraints).
 * - Check constraints, policies, enableRLS, generated columns.
 * - Tables in non-default Postgres schemas.
 *
 * For v0.2 DashFrame this is sufficient: first-boot creates tables, subsequent
 * boots are no-ops. Real schema evolution routes through migrations.
 */

import { sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { PgTable } from 'drizzle-orm/pg-core'

/** Anything that can execute a Drizzle SQL object. Covers both the PGLite-backed
 *  drizzle instance and the future tracked-db wrapper. */
export interface SyncTarget {
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle's execute return varies per driver
  execute: (query: ReturnType<typeof sql>) => Promise<any>
}

export async function syncSchema(db: SyncTarget, schema: Record<string, PgTable>): Promise<void> {
  const tables = Object.values(schema)
  const ordered = sortByFkDeps(tables)
  for (const table of ordered) {
    const ddl = renderCreateTableIfNotExists(table)
    await db.execute(sql.raw(ddl))
  }
}

/** Emits CREATE TABLE IF NOT EXISTS for a single pgTable. Exposed for
 *  advanced use (custom DDL pipelines, test assertions). */
export function renderCreateTableIfNotExists(table: PgTable): string {
  const cfg = getTableConfig(table)
  const lines: string[] = []

  for (const col of cfg.columns) {
    lines.push(renderColumn(col))
  }

  for (const pk of cfg.primaryKeys) {
    const cols = pk.columns.map((c) => quoteIdent(c.name)).join(', ')
    lines.push(`PRIMARY KEY (${cols})`)
  }

  for (const uc of cfg.uniqueConstraints) {
    const cols = uc.columns.map((c) => quoteIdent(c.name)).join(', ')
    const name = uc.name ?? `${cfg.name}_${uc.columns.map((c) => c.name).join('_')}_unique`
    lines.push(`CONSTRAINT ${quoteIdent(name)} UNIQUE (${cols})`)
  }

  for (const fk of cfg.foreignKeys) {
    lines.push(renderForeignKey(fk))
  }

  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(cfg.name)} (\n  ${lines.join(',\n  ')}\n);`
}

// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column types vary widely; we touch a common subset via duck typing
function renderColumn(col: any): string {
  const parts: string[] = [quoteIdent(col.name), col.getSQLType()]

  if (col.isArray) parts[parts.length - 1] += '[]'

  if (col.notNull) parts.push('NOT NULL')

  if (col.hasDefault && col.default !== undefined) {
    const expr = renderDefault(col.default)
    if (expr !== null) parts.push(`DEFAULT ${expr}`)
  }

  if (col.primary) parts.push('PRIMARY KEY')

  if (col.isUnique) parts.push('UNIQUE')

  return parts.join(' ')
}

// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle FK internals are not publicly typed for introspection
function renderForeignKey(fk: any): string {
  const ref = typeof fk.reference === 'function' ? fk.reference() : fk
  // oxlint-disable-next-line typescript/no-explicit-any
  const localCols = (ref.columns as any[]).map((c) => quoteIdent(c.name)).join(', ')
  // oxlint-disable-next-line typescript/no-explicit-any
  const foreignCols = (ref.foreignColumns as any[]).map((c) => quoteIdent(c.name)).join(', ')
  const foreignTable = ref.foreignTable ?? ref.foreignColumns?.[0]?.table
  const foreignName = foreignTable ? getTableConfig(foreignTable).name : '?'

  const clauses = [
    `FOREIGN KEY (${localCols})`,
    `REFERENCES ${quoteIdent(foreignName)} (${foreignCols})`,
  ]
  if (fk.onDelete) clauses.push(`ON DELETE ${String(fk.onDelete).toUpperCase()}`)
  if (fk.onUpdate) clauses.push(`ON UPDATE ${String(fk.onUpdate).toUpperCase()}`)
  return clauses.join(' ')
}

/** Serialize a Drizzle default value to its SQL form. Handles SQL objects
 *  (gen_random_uuid(), now()), literals (numbers, booleans, strings), and
 *  falls back to null for anything we can't round-trip. */
function renderDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null

  // SQL objects — walk queryChunks and concatenate.
  // oxlint-disable-next-line typescript/no-explicit-any
  const obj = value as any
  if (obj && Array.isArray(obj.queryChunks)) {
    return (
      obj.queryChunks
        // oxlint-disable-next-line typescript/no-explicit-any
        .map((chunk: any) => {
          const v = chunk?.value
          if (Array.isArray(v)) return v.join('')
          return String(v ?? '')
        })
        .join('')
    )
  }

  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
  return null
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

/** Topological sort: tables that don't reference others first. Self-references
 *  and cycles are emitted in insertion order as a last-resort fallback. */
function sortByFkDeps(tables: PgTable[]): PgTable[] {
  const cfgs = new Map(tables.map((t) => [t, getTableConfig(t)]))
  const result: PgTable[] = []
  const emitted = new Set<string>()

  // Fixed-point loop.
  while (result.length < tables.length) {
    let progressed = false
    for (const t of tables) {
      const cfg = cfgs.get(t)
      if (!cfg || emitted.has(cfg.name)) continue

      const deps = cfg.foreignKeys
        // oxlint-disable-next-line typescript/no-explicit-any
        .map((fk: any) => {
          const ref = typeof fk.reference === 'function' ? fk.reference() : fk
          const refTable = ref.foreignTable ?? ref.foreignColumns?.[0]?.table
          return refTable ? getTableConfig(refTable).name : null
        })
        .filter((name): name is string => name !== null && name !== cfg.name)

      if (deps.every((d) => emitted.has(d))) {
        result.push(t)
        emitted.add(cfg.name)
        progressed = true
      }
    }

    if (!progressed) {
      // Cycle detected — emit remaining in insertion order and let the DDL
      // engine sort it out (may fail with "table does not exist" on FK check).
      for (const t of tables) {
        const cfg = cfgs.get(t)
        if (cfg && !emitted.has(cfg.name)) {
          result.push(t)
          emitted.add(cfg.name)
        }
      }
      break
    }
  }

  return result
}
