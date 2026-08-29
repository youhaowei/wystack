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
import type { AnyColumnDef, ColumnDef, ColumnDefOptions } from './dsl'
import {
  TableDefinition,
  type TableCapabilities,
  type WithSelectedRow,
  type WithSystemManagedProperties,
} from './table'

type ColumnMap = Record<string, AnyColumnDef>
type AnyTableDefinition = TableDefinition<ColumnMap, boolean, string, string>
type DefinitionColumns<TDefinition> =
  TDefinition extends TableDefinition<
    infer TColumns,
    infer _Draftable,
    infer _Managed,
    infer _Revision
  >
    ? TColumns
    : never

type SelectedColumnValue<TColumn> =
  TColumn extends ColumnDef<infer TValue, infer TOptional, infer TNullable>
    ? TValue | (TOptional extends true ? null : never) | (TNullable extends true ? null : never)
    : never

type DefinitionSelectedRow<TDefinition> = {
  [K in keyof DefinitionColumns<TDefinition>]: SelectedColumnValue<
    DefinitionColumns<TDefinition>[K]
  >
}

type CompiledTable<TDefinition> = WithSystemManagedProperties<
  WithSelectedRow<ReturnType<typeof pgTable>, DefinitionSelectedRow<TDefinition>>,
  TDefinition
>
interface NormalizedTableDefinition {
  name: string
  columns: ColumnMap
  capabilities: TableCapabilities
}
type NormalizedSchema = Record<string, NormalizedTableDefinition>
// oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous compiled Drizzle tables
type CompiledSchema = Record<string, any>

interface ReferenceContext {
  tables: CompiledSchema
  definitions: NormalizedSchema
}

const tableCapabilities = new WeakMap<object, Readonly<TableCapabilities>>()
const generatedTables = new WeakMap<object, PgTable[]>()

function normalizeTableDefinition(definition: unknown): {
  columns: ColumnMap
  capabilities: TableCapabilities
} {
  if (definition instanceof TableDefinition) {
    return {
      columns: definition.columns,
      capabilities: definition.capabilities,
    }
  }
  throw new Error('defineSchema entries must use table(...) or multiTenant(...).table(...)')
}

function normalizeSchema(tables: Record<string, unknown>): NormalizedSchema {
  return Object.fromEntries(
    Object.entries(tables).map(([name, definition]) => [
      name,
      { name, ...normalizeTableDefinition(definition) },
    ]),
  )
}

function primaryKeyEntries(definition: NormalizedTableDefinition) {
  return Object.entries(definition.columns).filter(([, column]) => column.opts.isPrimaryKey)
}

function validateTableReferences(
  definition: NormalizedTableDefinition,
  schema: NormalizedSchema,
): void {
  const tenant = definition.capabilities.tenancy

  for (const [property, column] of Object.entries(definition.columns)) {
    const reference = column.opts.ref
    if (!reference) continue
    const target = Object.hasOwn(schema, reference.table) ? schema[reference.table] : undefined

    if (!reference.withinTenant && !target) {
      throw new Error(
        `Reference "${definition.name}.${property}" targets unknown table "${reference.table}"`,
      )
    }

    if (reference.withinTenant) {
      if (!tenant) {
        throw new Error(
          `Table "${definition.name}" uses tenant-local constraints but is not tenant-isolated`,
        )
      }
      if (!target) {
        throw new Error(
          `Tenant-local reference "${definition.name}.${property}" targets unknown table "${reference.table}"`,
        )
      }
      const targetTenant = target.capabilities.tenancy
      if (!targetTenant) {
        throw new Error(
          `Tenant-local reference "${definition.name}.${property}" targets non-tenant table "${reference.table}"`,
        )
      }
      if (targetTenant.property !== tenant.property || targetTenant.column !== tenant.column) {
        throw new Error(
          `Tenant-local reference "${definition.name}.${property}" targets a different tenancy descriptor`,
        )
      }
      if (reference.onDelete === 'set null') {
        throw new Error(
          `Tenant-local reference "${definition.name}.${property}" cannot use ON DELETE SET NULL because the composite foreign key includes the required tenant key`,
        )
      }
      if (target.capabilities.draftable && reference.onDelete === 'cascade') {
        throw new Error(
          `Reference "${definition.name}.${property}" cannot use ON DELETE CASCADE because draft deletes of "${reference.table}" cannot review or anchor untouched dependent rows`,
        )
      }
      continue
    }

    // A bare reference between tenant tables omits the tenant predicate and can
    // cross scopes. References to a global lookup table remain valid.
    if (tenant && target?.capabilities.tenancy) {
      throw new Error(
        `Reference "${definition.name}.${property}" targets tenant-isolated table "${reference.table}"; use referencesWithinTenant()`,
      )
    }
    if (
      target?.capabilities.draftable &&
      (reference.onDelete === 'cascade' || reference.onDelete === 'set null')
    ) {
      throw new Error(
        `Reference "${definition.name}.${property}" cannot use ON DELETE ${reference.onDelete.toUpperCase()} because draft deletes of "${reference.table}" cannot review or anchor untouched dependent rows`,
      )
    }
  }
}

function validateTableDefinition(
  definition: NormalizedTableDefinition,
  schema: NormalizedSchema,
): void {
  const tenantLocalColumns = Object.values(definition.columns).filter(
    (column) => column.opts.isUniqueWithinTenant || column.opts.ref?.withinTenant,
  )
  if (!definition.capabilities.tenancy && tenantLocalColumns.length > 0) {
    throw new Error(
      `Table "${definition.name}" uses tenant-local constraints but is not tenant-isolated`,
    )
  }

  const primaryKeys = primaryKeyEntries(definition)
  if (definition.capabilities.tenancy && primaryKeys.length !== 1) {
    throw new Error(`Tenant-isolated table "${definition.name}" requires exactly one primary key`)
  }
  if (definition.capabilities.draftable) {
    if (primaryKeys.length !== 1) {
      throw new Error(
        `Draftable table "${definition.name}" requires exactly one explicitly declared primary key`,
      )
    }
    const [primaryProperty, primaryKey] = primaryKeys[0]
    if (primaryKey.opts.isArray || !['int', 'text', 'uuid'].includes(primaryKey.opts.type)) {
      throw new Error(
        `Draftable table "${definition.name}" primary key "${primaryProperty}" must be a scalar int, text, or uuid`,
      )
    }
  }

  validateTableReferences(definition, schema)
}

function validateSchema(schema: NormalizedSchema): void {
  const reservedTable = Object.keys(schema).find((tableName) => tableName.startsWith('wystack_'))
  if (reservedTable) {
    throw new Error(
      `Table name "${reservedTable}" uses the reserved "wystack_" framework namespace`,
    )
  }

  const tenancyDescriptors = new Set(
    Object.values(schema)
      .map((definition) => definition.capabilities.tenancy?.descriptorId)
      .filter((descriptorId): descriptorId is symbol => descriptorId !== undefined),
  )
  if (tenancyDescriptors.size > 1) {
    throw new Error('defineSchema supports exactly one multiTenant descriptor')
  }

  for (const definition of Object.values(schema)) validateTableDefinition(definition, schema)
}

export function getTableCapabilities(table: object): TableCapabilities {
  const capabilities = tableCapabilities.get(table)
  if (!capabilities) throw new Error('Table was not compiled by defineSchema')
  return capabilities
}

export function tryGetTableCapabilities(table: object): TableCapabilities | undefined {
  return tableCapabilities.get(table)
}

/** Internal registration seam for low-level SQL fixtures that exercise the
 * tracker against hand-authored Drizzle tables. It is intentionally absent
 * from the package barrel; application code opts in through `table(...).draftable()`.
 */
export function registerTableCapabilities(table: object, capabilities: TableCapabilities): void {
  const tenancy = capabilities.tenancy ? Object.freeze({ ...capabilities.tenancy }) : undefined
  tableCapabilities.set(table, Object.freeze({ ...capabilities, tenancy }))
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

  if (!opts.isOptional && !opts.isNullable && !isSerial) {
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
      // Resolve lazily because the second compile pass may replace a referenced
      // table after this column is built.
      col = col.references(() => allTables[opts.ref!.table][opts.ref!.column], refOpts)
    }
  }

  return col
}

function compileColumns(definition: NormalizedTableDefinition, references?: ReferenceContext) {
  // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle column builders
  const colDefs: Record<string, any> = {}
  for (const [property, column] of Object.entries(definition.columns)) {
    const sqlName =
      definition.capabilities.tenancy?.property === property
        ? definition.capabilities.tenancy.column
        : property
    const opts =
      definition.capabilities.revisionProperty === property
        ? { ...column.opts, hasDefault: true, defaultValue: 1 }
        : column.opts
    colDefs[property] = buildColumn(property, opts, references?.tables ?? {}, sqlName)
  }
  return colDefs
}

function compileTable(definition: NormalizedTableDefinition, references?: ReferenceContext) {
  const colDefs = compileColumns(definition, references)
  const tenant = definition.capabilities.tenancy
  if (!tenant) return pgTable(definition.name, colDefs)

  const [primaryProperty] = primaryKeyEntries(definition)[0]

  return pgTable(definition.name, colDefs, (current) => {
    const constraints: PgTableExtraConfigValue[] = [
      unique(`${definition.name}_${tenant.column}_${current[primaryProperty].name}_unique`).on(
        current[tenant.property],
        current[primaryProperty],
      ),
    ]

    for (const [property, column] of Object.entries(definition.columns)) {
      if (column.opts.isUniqueWithinTenant) {
        constraints.push(
          unique(`${definition.name}_${tenant.column}_${current[property].name}_unique`).on(
            current[tenant.property],
            current[property],
          ),
        )
      }
      const ref = column.opts.ref
      if (!ref?.withinTenant || !references) continue
      const target = references.tables[ref.table]
      if (!target) continue
      const targetTenant = references.definitions[ref.table].capabilities.tenancy!
      let constraint = foreignKey({
        columns: [current[tenant.property], current[property]],
        foreignColumns: [target[targetTenant.property], target[ref.column]],
      })
      if (ref.onDelete) constraint = constraint.onDelete(ref.onDelete)
      constraints.push(constraint)
    }
    return constraints
  })
}

function hasReferences(definition: NormalizedTableDefinition): boolean {
  return Object.values(definition.columns).some((column) => column.opts.ref !== undefined)
}

function compileSchema(schema: NormalizedSchema): CompiledSchema {
  const compiled: CompiledSchema = {}

  // First compile every table without references so all targets exist.
  for (const definition of Object.values(schema)) {
    compiled[definition.name] = compileTable(definition)
    registerTableCapabilities(compiled[definition.name], definition.capabilities)
  }

  // Then rebuild only tables that declare references against the complete map.
  const references = { tables: compiled, definitions: schema }
  for (const definition of Object.values(schema).filter(hasReferences)) {
    compiled[definition.name] = compileTable(definition, references)
    registerTableCapabilities(compiled[definition.name], definition.capabilities)
  }

  return compiled
}

/**
 * Every draft row delta is stored in one relation. `row_key` and `tenant_key`
 * retain a typed JSON envelope for inspection and diagnostics while their
 * canonical text forms make the btree identity lossless and indexable.
 */
function buildDraftChangesTable() {
  return pgTable(
    'wystack_draft_row_changes',
    {
      draftId: pgText('draft_id').notNull(),
      tableKey: pgText('table_key').notNull(),
      tenantKeyText: pgText('tenant_key_text').notNull().default(''),
      tenantKey: pgJsonb('tenant_key'),
      rowKeyText: pgText('row_key_text').notNull(),
      rowKey: pgJsonb('row_key').notNull(),
      operation: pgText('operation').notNull(),
      baseExists: pgBoolean('base_exists').notNull(),
      baseRevision: pgJsonb('base_revision'),
      fields: pgJsonb('fields').notNull().default({}),
    },
    (change) => [
      primaryKey({
        columns: [change.draftId, change.tableKey, change.tenantKeyText, change.rowKeyText],
      }),
    ],
  )
}

/** Durable per-row incarnation tokens prevent delete/reinsert from resetting CAS to 1. */
function buildRowRevisionsTable() {
  return pgTable(
    'wystack_row_revisions',
    {
      tableKey: pgText('table_key').notNull(),
      tenantKeyText: pgText('tenant_key_text').notNull().default(''),
      rowKeyText: pgText('row_key_text').notNull(),
      revision: integer('revision').notNull(),
    },
    (row) => [
      primaryKey({
        columns: [row.tableKey, row.tenantKeyText, row.rowKeyText],
      }),
    ],
  )
}

function buildGeneratedTables(schema: NormalizedSchema): PgTable[] {
  const definitions = Object.values(schema)
  return [
    ...(definitions.some((definition) => definition.capabilities.draftable)
      ? [buildDraftChangesTable()]
      : []),
    ...(definitions.some((definition) => definition.capabilities.revisionProperty)
      ? [buildRowRevisionsTable()]
      : []),
  ]
}

export function defineSchema<const T extends Record<string, unknown>>(
  tables: T & { [K in keyof T]: AnyTableDefinition },
) {
  const definitions = normalizeSchema(tables)
  validateSchema(definitions)
  const compiled = compileSchema(definitions) as { [K in keyof T]: CompiledTable<T[K]> }
  generatedTables.set(compiled, buildGeneratedTables(definitions))
  return compiled
}
