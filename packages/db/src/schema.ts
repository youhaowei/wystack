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
  primaryKey,
  unique,
  foreignKey,
} from 'drizzle-orm/pg-core'
import type { PgTable, PgTableExtraConfigValue } from 'drizzle-orm/pg-core'
import type { AnyColumnDef, ColumnDefOptions } from './dsl'
import { TableDefinition, type TableCapabilities } from './table'

type ColumnMap = Record<string, AnyColumnDef>
type AnyTableDefinition = TableDefinition<ColumnMap, boolean>

const tableCapabilities = new WeakMap<object, TableCapabilities>()
const generatedTables = new WeakMap<object, PgTable[]>()

function normalizeTableDefinition(definition: unknown): {
  columns: ColumnMap
  capabilities: TableCapabilities
} {
  if (definition instanceof TableDefinition) {
    return { columns: definition.columns, capabilities: definition.capabilities }
  }
  throw new Error('defineSchema entries must use table(...) or multiTenant(...).table(...)')
}

export function getTableCapabilities(table: object): TableCapabilities {
  const capabilities = tableCapabilities.get(table)
  if (!capabilities) throw new Error('Table was not compiled by defineSchema')
  return capabilities
}

export function tryGetTableCapabilities(table: object): TableCapabilities | undefined {
  return tableCapabilities.get(table)
}

export function getGeneratedTables(schema: object): PgTable[] {
  return [...(generatedTables.get(schema) ?? [])]
}

function buildColumn(
  name: string,
  opts: ColumnDefOptions,
  // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle pgTable objects need dynamic column access for foreign key references
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

  if (opts.ref && !opts.ref.withinTenant) {
    const refTable = allTables[opts.ref.table]
    if (refTable) {
      const refOpts: Record<string, unknown> = {}
      if (opts.ref.onDelete) refOpts.onDelete = opts.ref.onDelete
      col = col.references(() => refTable[opts.ref!.column], refOpts)
    }
  }

  return col
}

function buildTable(
  tableName: string,
  columns: ColumnMap,
  capabilities: TableCapabilities,
  // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous compiled Drizzle tables
  allTables: Record<string, any>,
) {
  // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle column builders
  const colDefs: Record<string, any> = {}
  for (const [property, definition] of Object.entries(columns)) {
    const sqlName =
      capabilities.tenancy?.property === property ? capabilities.tenancy.column : property
    colDefs[property] = buildColumn(property, definition.opts, allTables, sqlName)
  }

  const tenant = capabilities.tenancy
  const tenantLocalColumns = Object.entries(columns).filter(
    ([, definition]) => definition.opts.isUniqueWithinTenant || definition.opts.ref?.withinTenant,
  )
  if (!tenant && tenantLocalColumns.length > 0) {
    throw new Error(`Table "${tableName}" uses tenant-local constraints but is not tenant-isolated`)
  }
  if (!tenant) return pgTable(tableName, colDefs)

  const primaryEntries = Object.entries(columns).filter(
    ([, definition]) => definition.opts.isPrimaryKey,
  )
  if (primaryEntries.length !== 1) {
    throw new Error(`Tenant-isolated table "${tableName}" requires exactly one primary key`)
  }
  const [primaryProperty] = primaryEntries[0]

  const compiled = pgTable(tableName, colDefs, (current) => {
    const constraints: PgTableExtraConfigValue[] = [
      unique(`${tableName}_${tenant.column}_${current[primaryProperty].name}_unique`).on(
        current[tenant.property],
        current[primaryProperty],
      ),
    ]

    for (const [property, definition] of Object.entries(columns)) {
      if (definition.opts.isUniqueWithinTenant) {
        constraints.push(
          unique(`${tableName}_${tenant.column}_${current[property].name}_unique`).on(
            current[tenant.property],
            current[property],
          ),
        )
      }
      const ref = definition.opts.ref
      if (!ref?.withinTenant || !allTables[ref.table]) continue
      const target = allTables[ref.table]
      const targetTenant = tryGetTableCapabilities(target)?.tenancy
      if (!targetTenant) {
        throw new Error(
          `Tenant-local reference "${tableName}.${property}" targets non-tenant table "${ref.table}"`,
        )
      }
      if (targetTenant.property !== tenant.property || targetTenant.column !== tenant.column) {
        throw new Error(
          `Tenant-local reference "${tableName}.${property}" targets a different tenancy descriptor`,
        )
      }
      let constraint = foreignKey({
        columns: [current[tenant.property], current[property]],
        foreignColumns: [target[targetTenant.property], target[ref.column]],
      })
      if (ref.onDelete) constraint = constraint.onDelete(ref.onDelete)
      constraints.push(constraint)
    }
    return constraints
  })
  return compiled
}

function buildDraftTable(tableName: string, columns: ColumnMap, capabilities: TableCapabilities) {
  const primaryEntries = Object.entries(columns).filter(([, column]) => column.opts.isPrimaryKey)
  if (primaryEntries.length !== 1) {
    throw new Error(
      `Draftable table "${tableName}" requires exactly one explicitly declared primary key`,
    )
  }

  const [primaryProperty, primaryDefinition] = primaryEntries[0]
  const tenantProperty = capabilities.tenancy?.property
  const reservedSqlNames = new Set(['draft_id', '__overrides', '__tombstone'])
  for (const [property, definition] of Object.entries(columns)) {
    const sqlName =
      capabilities.tenancy?.property === property ? capabilities.tenancy.column : property
    if (reservedSqlNames.has(sqlName)) {
      throw new Error(
        `Draftable table "${tableName}" column "${property}" collides with reserved shadow column "${sqlName}"`,
      )
    }
    if (definition.opts.isPrimaryKey && property !== primaryProperty) {
      throw new Error(`Draftable table "${tableName}" has multiple primary keys`)
    }
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle column builders
  const shadowColumns: Record<string, any> = {
    draftId: pgText('draft_id').notNull(),
  }

  if (capabilities.tenancy) {
    const tenantDefinition = columns[capabilities.tenancy.property]
    shadowColumns[capabilities.tenancy.property] = buildColumn(
      capabilities.tenancy.property,
      {
        ...tenantDefinition.opts,
        isPrimaryKey: false,
        isUnique: false,
        isUniqueWithinTenant: false,
        ref: undefined,
      },
      {},
      capabilities.tenancy.column,
    )
  }

  shadowColumns[primaryProperty] = buildColumn(
    primaryProperty,
    {
      ...primaryDefinition.opts,
      isPrimaryKey: false,
      isUnique: false,
      isUniqueWithinTenant: false,
      hasDefault: false,
      defaultValue: undefined,
      isDefaultNow: false,
      isDefaultRandom: false,
      ref: undefined,
    },
    {},
  )

  for (const [property, definition] of Object.entries(columns)) {
    if (property === primaryProperty || property === tenantProperty) continue
    shadowColumns[property] = buildColumn(
      property,
      {
        ...definition.opts,
        isOptional: true,
        isNullable: true,
        isPrimaryKey: false,
        isUnique: false,
        isUniqueWithinTenant: false,
        hasDefault: false,
        defaultValue: undefined,
        isDefaultNow: false,
        isDefaultRandom: false,
        ref: undefined,
      },
      {},
    )
  }

  shadowColumns.__overrides = pgText('__overrides').array().notNull().default([])
  shadowColumns.__tombstone = pgBoolean('__tombstone').notNull().default(false)

  const shadow = pgTable(`${tableName}__draft`, shadowColumns, (draft) => {
    const keyColumns = [draft.draftId] as [typeof draft.draftId, ...(typeof draft.draftId)[]]
    if (capabilities.tenancy) keyColumns.push(draft[capabilities.tenancy.property])
    keyColumns.push(draft[primaryProperty])
    return [primaryKey({ columns: keyColumns })]
  })
  tableCapabilities.set(shadow, { draftable: false, tenancy: capabilities.tenancy })
  return shadow
}

export function defineSchema<const T extends Record<string, unknown>>(
  tables: T & { [K in keyof T]: AnyTableDefinition },
) {
  const tenancyDescriptors = new Set(
    Object.values(tables)
      .map((definition) => normalizeTableDefinition(definition).capabilities.tenancy?.descriptorId)
      .filter((descriptorId): descriptorId is symbol => descriptorId !== undefined),
  )
  if (tenancyDescriptors.size > 1) {
    throw new Error('defineSchema supports exactly one multiTenant descriptor')
  }

  // oxlint-disable-next-line typescript/no-explicit-any -- accumulates Drizzle pgTable objects passed to buildColumn for references
  const result: Record<string, any> = {}

  // Pass 1: create all tables without foreign key references
  for (const [tableName, definition] of Object.entries(tables)) {
    const { columns, capabilities } = normalizeTableDefinition(definition)
    result[tableName] = buildTable(tableName, columns, capabilities, {})
    tableCapabilities.set(result[tableName], capabilities)
  }

  // Pass 2: rebuild tables that have foreign key references (now all tables exist)
  for (const [tableName, definition] of Object.entries(tables)) {
    const { columns, capabilities } = normalizeTableDefinition(definition)
    const hasRefs = Object.values(columns).some((c) => c.opts.ref)
    if (!hasRefs) continue

    result[tableName] = buildTable(tableName, columns, capabilities, result)
    tableCapabilities.set(result[tableName], capabilities)
  }

  const compiled = result as { [K in keyof T]: ReturnType<typeof pgTable> }
  const generated: PgTable[] = []
  for (const [tableName, definition] of Object.entries(tables)) {
    const { columns, capabilities } = normalizeTableDefinition(definition)
    if (capabilities.draftable) generated.push(buildDraftTable(tableName, columns, capabilities))
  }
  generatedTables.set(compiled, generated)
  return compiled
}
