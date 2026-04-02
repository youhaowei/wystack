/**
 * defineSchema: takes a WyStack DSL table map and produces Drizzle pgTable definitions.
 */
import {
  pgTable,
  text as pgText,
  integer,
  serial,
  boolean as pgBoolean,
  timestamp as pgTimestamp,
  jsonb as pgJsonb,
  uuid as pgUuid,
} from 'drizzle-orm/pg-core'
import type { AnyColumnDef, ColumnDefOptions } from './dsl'

type TableDefs = Record<string, Record<string, AnyColumnDef>>

// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle pgTable objects need dynamic column access for foreign key references
function buildColumn(name: string, opts: ColumnDefOptions, allTables: Record<string, any>) {
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column builder types vary per column type; no common base type
  let col: any
  const isSerial = opts.type === 'int' && opts.isPrimaryKey

  switch (opts.type) {
    case 'text':
      col = pgText(name)
      break
    case 'int':
      col = isSerial ? serial(name) : integer(name)
      break
    case 'boolean':
      col = pgBoolean(name)
      break
    case 'timestamp':
      col = pgTimestamp(name)
      break
    case 'jsonb':
      col = pgJsonb(name)
      break
    case 'uuid':
      col = pgUuid(name)
      break
    default: {
      const _exhaustive: never = opts.type
      throw new Error(`Unsupported column type: ${opts.type}`)
    }
  }

  if (opts.isArray) {
    col = col.array()
  }

  if (!opts.isOptional && !opts.hasDefault && !isSerial) {
    col = col.notNull()
  }

  if (opts.isPrimaryKey && !isSerial) {
    col = col.primaryKey()
  }

  if (opts.isUnique) {
    col = col.unique()
  }

  if (opts.isDefaultRandom) {
    col = col.defaultRandom()
  }

  if (opts.isDefaultNow) {
    col = col.defaultNow()
  }

  if (opts.hasDefault && opts.defaultValue !== undefined) {
    col = col.default(opts.defaultValue)
  }

  if (opts.ref) {
    const refTable = allTables[opts.ref.table]
    if (refTable) {
      const refOpts: Record<string, unknown> = {}
      if (opts.ref.onDelete) refOpts.onDelete = opts.ref.onDelete
      col = col.references(() => refTable[opts.ref!.column], refOpts)
    }
  }

  return col
}

export function defineSchema<T extends TableDefs>(tables: T) {
  // oxlint-disable-next-line typescript/no-explicit-any -- accumulates Drizzle pgTable objects passed to buildColumn for references
  const result: Record<string, any> = {}

  // Pass 1: create all tables without foreign key references
  for (const [tableName, columns] of Object.entries(tables)) {
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column builders have heterogeneous types
    const colDefs: Record<string, any> = {}
    for (const [colName, colDef] of Object.entries(columns)) {
      colDefs[colName] = buildColumn(colName, colDef.opts, {})
    }
    result[tableName] = pgTable(tableName, colDefs)
  }

  // Pass 2: rebuild tables that have foreign key references (now all tables exist)
  for (const [tableName, columns] of Object.entries(tables)) {
    const hasRefs = Object.values(columns).some((c) => c.opts.ref)
    if (!hasRefs) continue

    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column builders have heterogeneous types
    const colDefs: Record<string, any> = {}
    for (const [colName, colDef] of Object.entries(columns)) {
      colDefs[colName] = buildColumn(colName, colDef.opts, result)
    }
    result[tableName] = pgTable(tableName, colDefs)
  }

  return result as { [K in keyof T]: ReturnType<typeof pgTable> }
}
