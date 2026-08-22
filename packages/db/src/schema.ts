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
import { TableDefinition, type TableCapabilities } from './table'

type LegacyTableDefinition = Record<string, AnyColumnDef>
type AnyTableDefinition = TableDefinition<LegacyTableDefinition, boolean> | LegacyTableDefinition
type TableDefs = Record<string, AnyTableDefinition>

const tableCapabilities = new WeakMap<object, TableCapabilities>()

function normalizeTableDefinition(definition: AnyTableDefinition): {
  columns: LegacyTableDefinition
  capabilities: TableCapabilities
} {
  if (definition instanceof TableDefinition) {
    return { columns: definition.columns, capabilities: definition.capabilities }
  }
  return { columns: definition, capabilities: { draftable: false } }
}

export function getTableCapabilities(table: object): TableCapabilities {
  const capabilities = tableCapabilities.get(table)
  if (!capabilities) throw new Error('Table was not compiled by defineSchema')
  return capabilities
}

// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle pgTable objects need dynamic column access for foreign key references
function buildColumn(
  name: string,
  opts: ColumnDefOptions,
  allTables: Record<string, any>,
  sqlName: string = name,
) {
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column builder types vary per column type; no common base type
  let col: any
  const isSerial = opts.type === 'int' && opts.isPrimaryKey

  switch (opts.type) {
    case 'text':
      col = pgText(sqlName)
      break
    case 'int':
      col = isSerial ? serial(sqlName) : integer(sqlName)
      break
    case 'boolean':
      col = pgBoolean(sqlName)
      break
    case 'timestamp':
      col = pgTimestamp(sqlName)
      break
    case 'jsonb':
      col = pgJsonb(sqlName)
      break
    case 'uuid':
      col = pgUuid(sqlName)
      break
    default: {
      const _exhaustive: never = opts.type
      throw new Error(`Unsupported column type: ${opts.type}`)
    }
  }

  if (opts.isArray) {
    col = col.array()
  }

  if (!opts.isOptional && !opts.isNullable && !opts.hasDefault && !isSerial) {
    col = col.notNull()
  }

  // Mark the PK primary in Drizzle metadata for BOTH the integer and serial
  // paths. `serial()` alone does not set the column's `primary` flag, so without
  // this a serial PK is invisible to PK detection that reads column/table
  // metadata (e.g. the draft coalesce primitive) — and the generated DDL would
  // omit PRIMARY KEY. Chaining `.primaryKey()` onto serial keeps its SQL type
  // (`serial`) while recording the primary-key constraint.
  if (opts.isPrimaryKey) {
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
  for (const [tableName, definition] of Object.entries(tables)) {
    const { columns, capabilities } = normalizeTableDefinition(definition)
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column builders have heterogeneous types
    const colDefs: Record<string, any> = {}
    for (const [colName, colDef] of Object.entries(columns)) {
      const sqlName = capabilities.tenancy?.property === colName ? capabilities.tenancy.column : colName
      colDefs[colName] = buildColumn(colName, colDef.opts, {}, sqlName)
    }
    result[tableName] = pgTable(tableName, colDefs)
    tableCapabilities.set(result[tableName], capabilities)
  }

  // Pass 2: rebuild tables that have foreign key references (now all tables exist)
  for (const [tableName, definition] of Object.entries(tables)) {
    const { columns, capabilities } = normalizeTableDefinition(definition)
    const hasRefs = Object.values(columns).some((c) => c.opts.ref)
    if (!hasRefs) continue

    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column builders have heterogeneous types
    const colDefs: Record<string, any> = {}
    for (const [colName, colDef] of Object.entries(columns)) {
      const sqlName = capabilities.tenancy?.property === colName ? capabilities.tenancy.column : colName
      colDefs[colName] = buildColumn(colName, colDef.opts, result, sqlName)
    }
    result[tableName] = pgTable(tableName, colDefs)
    tableCapabilities.set(result[tableName], capabilities)
  }

  return result as { [K in keyof T]: ReturnType<typeof pgTable> }
}
