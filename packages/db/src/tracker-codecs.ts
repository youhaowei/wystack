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
 * Composite PKs (2+ columns) are unsupported — the overlay join/upsert is
 * single-key — so we throw a clear error rather than silently keying on the
 * wrong column. Shared by the draft READ coalesce (`DraftSelectBuilder.all`)
 * and the draft WRITE path (`writeDraftRow` / `DraftSelectBuilder.update/delete`)
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
          `by the draft overlay (single-key join/upsert).`,
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
        `by the draft overlay (single-key join/upsert).`,
    )
  }
  if (inlinePks.length === 1) return inlinePks[0].name

  // Last resort: a column whose SQL name is literally "id". This assumes the
  // `id` column is the row identity (it is for every defineSchema table —
  // serial PKs are now marked primary above — and the documented convention
  // for raw pgTable callers). If a table has a non-unique `id` that is NOT the
  // identity, the overlay join/upsert would mis-key; such a table must declare an
  // explicit primary key so resolution takes a branch above instead.
  const idCol = config.columns.find((c) => c.name === 'id')
  if (idCol) return idCol.name

  throw new Error(
    `draft overlay: table "${tableName}" has no primary key column and no column named "id". ` +
      `Cannot key the draft overlay.`,
  )
}

/**
 * Route a value through a Drizzle column's driver codec, mirroring the canonical
 * INSERT/UPDATE lowering. A `null`/`undefined` is passed through untouched: a
 * codec like `jsonb`'s `JSON.stringify` would otherwise turn `null` into the
 * literal string `"null"` (and `undefined` into `undefined`), corrupting the
 * sparse-overlay semantics. Callers omit `undefined` before encoding; a
 * preserved `null` is an explicit SQL NULL and is encoded as `sql-null`.
 * Concrete values (`fields: [...]`, `done: true`) are the cases that need a
 * non-identity codec.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
export function mapColumnValue(col: any, value: unknown): unknown {
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
 * `null`/`undefined` is passed through untouched, mirroring the write side.
 * Callers omit `undefined`; a NULL in a coalesced row is the explicit SQL NULL
 * selected by canonical data or a draft override, never a no-change sentinel.
 * (jsonb's decoder would already no-op on null, but the explicit passthrough
 * keeps read/write symmetry exact.)
 */
// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
export function mapColumnValueFromDriver(col: any, value: unknown): unknown {
  if (value === null || value === undefined) return value
  return col.mapFromDriverValue(value)
}

import { getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { AnyTable } from './tracker-core'
