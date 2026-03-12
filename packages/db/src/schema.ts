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
} from 'drizzle-orm/pg-core'
import type { ColumnDef, ColumnDefOptions } from './dsl'

type TableDefs = Record<string, Record<string, ColumnDef<any, any>>>

function buildColumn(name: string, opts: ColumnDefOptions) {
  let col: any

  switch (opts.type) {
    case 'text':
      col = pgText(name)
      break
    case 'int':
      col = opts.isPrimaryKey ? serial(name) : integer(name)
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
    default: {
      const _exhaustive: never = opts.type
      throw new Error(`Unsupported column type: ${opts.type}`)
    }
  }

  const isSerial = opts.type === 'int' && opts.isPrimaryKey

  if (!opts.isOptional && !opts.hasDefault && !isSerial) {
    col = col.notNull()
  }

  // serial already implies primaryKey — only call .primaryKey() for non-serial columns
  if (opts.isPrimaryKey && !isSerial) {
    col = col.primaryKey()
  }

  if (opts.isUnique) {
    col = col.unique()
  }

  if (opts.hasDefault && opts.defaultValue !== undefined) {
    col = col.default(opts.defaultValue)
  }

  return col
}

export function defineSchema<T extends TableDefs>(tables: T) {
  const result: Record<string, any> = {}

  for (const [tableName, columns] of Object.entries(tables)) {
    const colDefs: Record<string, any> = {}
    for (const [colName, colDef] of Object.entries(columns)) {
      colDefs[colName] = buildColumn(colName, colDef.opts)
    }
    result[tableName] = pgTable(tableName, colDefs)
  }

  return result as { [K in keyof T]: ReturnType<typeof pgTable> }
}
