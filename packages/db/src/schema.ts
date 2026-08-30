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
import { getTableColumns, getTableName } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import type { PgTable, PgTableExtraConfigValue, PgTableWithColumns } from 'drizzle-orm/pg-core'
import type { AnyColumnDef, ColumnDef, ColumnDefOptions } from './dsl'
import {
  TableDefinition,
  getTenantCapability,
  type CarriesSystemManagedProperties,
  type MultiTenantDescriptor,
  type TableCapabilities,
  type TenantKeyDefinition,
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
const logicalPrimaryKeyColumns = new WeakMap<object, string>()
const generatedTables = new WeakMap<object, PgTable[]>()

interface AdoptedRegistration {
  capabilities: Readonly<TableCapabilities>
  identity: 'tenant-primary' | 'global-primary-compatibility'
  logicalPrimaryKeyProperty: string
  logicalPrimaryKeyColumn: string
}

// Intentionally strong: cross-call adoption validates one module-lifetime table
// graph, so later foreign-key checks must retain prior Drizzle table objects.
const adoptedRegistrations = new Map<AnyPgTable, AdoptedRegistration>()

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

    // A bare reference to a tenant table omits the tenant predicate, regardless
    // of whether the source table is tenant-scoped. Global lookup targets remain valid.
    if (target?.capabilities.tenancy) {
      if (!tenant) {
        throw new Error(
          `Reference "${definition.name}.${property}" targets tenant-isolated table "${reference.table}"; make the source table tenant-isolated and use referencesWithinTenant()`,
        )
      }
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
  if (definition.capabilities.tenancy) {
    if (primaryKeys.length !== 1) {
      throw new Error(`Tenant-isolated table "${definition.name}" requires exactly one primary key`)
    }
    if (primaryKeys[0][0] === definition.capabilities.tenancy.property) {
      throw new Error(
        `Tenant-isolated table "${definition.name}" requires a logical primary key separate from the tenant key`,
      )
    }
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

/** Internal scalar row identity for compiled tenant tables. The physical SQL
 * primary key also includes tenant scope, but draft storage carries that key in
 * its own field and therefore resolves rows by this logical column.
 */
export function tryGetLogicalPrimaryKeyColumn(table: object): string | undefined {
  return logicalPrimaryKeyColumns.get(table)
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
  inlinePrimaryKey: boolean = true,
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
  if (opts.isPrimaryKey && inlinePrimaryKey) {
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
    // A tenant table's declared PK is its logical row identity. Physically the
    // database keys the row by (tenant, logical identity), so the logical column
    // must not also emit a second, globally unique inline PRIMARY KEY.
    const inlinePrimaryKey = !definition.capabilities.tenancy
    colDefs[property] = buildColumn(
      property,
      opts,
      references?.tables ?? {},
      sqlName,
      inlinePrimaryKey,
    )
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
      primaryKey({
        columns: [current[tenant.property], current[primaryProperty]],
      }),
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

  const registerCompiledTable = (
    definition: NormalizedTableDefinition,
    // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous compiled Drizzle tables
    compiledTable: any,
  ) => {
    registerTableCapabilities(compiledTable, definition.capabilities)
    const [primaryProperty] = primaryKeyEntries(definition)[0] ?? []
    if (primaryProperty) {
      logicalPrimaryKeyColumns.set(compiledTable, compiledTable[primaryProperty].name)
    }
  }

  // First compile every table without references so all targets exist.
  for (const definition of Object.values(schema)) {
    compiled[definition.name] = compileTable(definition)
    registerCompiledTable(definition, compiled[definition.name])
  }

  // Then rebuild only tables that declare references against the complete map.
  const references = { tables: compiled, definitions: schema }
  for (const definition of Object.values(schema).filter(hasReferences)) {
    compiled[definition.name] = compileTable(definition, references)
    registerCompiledTable(definition, compiled[definition.name])
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

// oxlint-disable-next-line typescript/no-explicit-any -- adoption preserves heterogeneous Drizzle tables
type AnyPgTable = PgTableWithColumns<any>

export interface AdoptedTableConfig<
  TTable extends AnyPgTable = AnyPgTable,
  TLogicalPrimaryKey extends string = string,
  TRevisionProperty extends string | undefined = string | undefined,
  TSoftDeleteProperty extends string | undefined = string | undefined,
> {
  /** The authoritative application-owned Drizzle table object. */
  table: TTable
  /** JS property naming the row identity inside one tenant. */
  logicalPrimaryKey: TLogicalPrimaryKey
  /**
   * Expand/contract bridge for mature schemas. The default requires the tenant
   * and logical key to be the physical primary key. Compatibility mode keeps a
   * global logical primary key temporarily, but requires an equivalent tenant
   * unique constraint so tenant-qualified foreign keys can land first.
   */
  identity?: 'tenant-primary' | 'global-primary-compatibility'
  /** Opt in only when handlers are valid against the draft overlay. */
  draftable?: boolean
  /** Optional framework-managed integer compare-and-swap property. */
  revisionProperty?: TRevisionProperty
  /** Optional framework-managed nullable timestamp tombstone property. */
  softDeleteProperty?: TSoftDeleteProperty
}

type AdoptedSystemProperties<
  TDescriptor extends MultiTenantDescriptor<TenantKeyDefinition>,
  TConfig,
> =
  | TDescriptor['key']['property']
  | (TConfig extends { revisionProperty: infer TRevision extends string } ? TRevision : never)
  | (TConfig extends { softDeleteProperty: infer TDeleted extends string } ? TDeleted : never)

type AdoptedSchema<
  TDescriptor extends MultiTenantDescriptor<TenantKeyDefinition>,
  TTables extends Record<string, AdoptedTableConfig>,
> = {
  [K in keyof TTables]: TTables[K]['table'] &
    CarriesSystemManagedProperties<AdoptedSystemProperties<TDescriptor, TTables[K]>>
}

interface AdoptedEntry extends AdoptedRegistration {
  table: AnyPgTable
}

function sameAdoptedRegistration(left: AdoptedRegistration, right: AdoptedRegistration): boolean {
  return (
    left.identity === right.identity &&
    left.logicalPrimaryKeyProperty === right.logicalPrimaryKeyProperty &&
    left.logicalPrimaryKeyColumn === right.logicalPrimaryKeyColumn &&
    left.capabilities.draftable === right.capabilities.draftable &&
    left.capabilities.revisionProperty === right.capabilities.revisionProperty &&
    left.capabilities.softDeleteProperty === right.capabilities.softDeleteProperty &&
    left.capabilities.tenancy?.descriptorId === right.capabilities.tenancy?.descriptorId
  )
}

function normalizedIdentitySqlType(type: string): string {
  const normalized = type.toLowerCase()
  if (normalized === 'serial') return 'integer'
  if (normalized === 'bigserial') return 'bigint'
  if (normalized === 'smallserial') return 'smallint'
  return normalized
}

function adoptedColumn(
  table: AnyPgTable,
  property: string,
): {
  name: string
  notNull: boolean
  primary: boolean
  hasDefault: boolean
  isUnique: boolean
  getSQLType(): string
} {
  const columns = getTableColumns(table) as Record<
    string,
    {
      name: string
      notNull: boolean
      primary: boolean
      hasDefault: boolean
      isUnique: boolean
      getSQLType(): string
    }
  >
  const column = Object.hasOwn(columns, property) ? columns[property] : undefined
  if (!column) {
    throw new Error(`Adopted table "${getTableName(table)}" has no property "${property}"`)
  }
  return column
}

function assertAdoptedIdentity(
  table: AnyPgTable,
  logicalPrimaryKey: string,
  tenancy: TableCapabilities['tenancy'] & {},
  identity: AdoptedTableConfig['identity'],
): void {
  const tableName = getTableName(table)
  const tenantColumn = adoptedColumn(table, tenancy.property)
  const logicalColumn = adoptedColumn(table, logicalPrimaryKey)
  if (tenantColumn.name !== tenancy.column) {
    throw new Error(
      `Adopted table "${tableName}" tenant property "${tenancy.property}" must use SQL column "${tenancy.column}"`,
    )
  }
  if (!tenantColumn.notNull) {
    throw new Error(
      `Adopted table "${tableName}" tenant column "${tenancy.column}" must be NOT NULL`,
    )
  }
  const expectedTenantType = tenancy.type.opts.type === 'int' ? 'integer' : tenancy.type.opts.type
  if (normalizedIdentitySqlType(tenantColumn.getSQLType()) !== expectedTenantType) {
    throw new Error(
      `Adopted table "${tableName}" tenant column "${tenancy.column}" must use ${expectedTenantType}`,
    )
  }
  if (logicalPrimaryKey === tenancy.property || logicalColumn === tenantColumn) {
    throw new Error(
      `Adopted table "${tableName}" requires a logical identity separate from its tenant`,
    )
  }
  const tableConfig = getTableConfig(table)
  const primaryKeys = tableConfig.primaryKeys
  const expected = [tenantColumn.name, logicalColumn.name]
  const hasExpectedPrimaryKey =
    primaryKeys.length === 1 &&
    primaryKeys[0].columns.length === expected.length &&
    primaryKeys[0].columns.every((column, index) => column.name === expected[index])
  const inlinePrimary = tableConfig.columns.filter((column) => column.primary)
  if (identity === 'global-primary-compatibility') {
    const hasGlobalPrimaryKey =
      (primaryKeys.length === 1 &&
        primaryKeys[0].columns.length === 1 &&
        primaryKeys[0].columns[0].name === logicalColumn.name &&
        inlinePrimary.length === 0) ||
      (primaryKeys.length === 0 &&
        inlinePrimary.length === 1 &&
        inlinePrimary[0].name === logicalColumn.name)
    const hasTenantUnique = [
      ...tableConfig.uniqueConstraints.map((constraint) => constraint.columns),
      ...tableConfig.indexes
        .filter((index) => index.config.unique && index.config.where === undefined)
        .map((index) => index.config.columns),
    ].some(
      (columns) =>
        columns.length === expected.length &&
        columns.every((column, index) => 'name' in column && column.name === expected[index]),
    )
    if (!hasGlobalPrimaryKey || !hasTenantUnique) {
      throw new Error(
        `Adopted table "${tableName}" compatibility identity requires global primary key "${logicalColumn.name}" and unique (${expected.join(', ')})`,
      )
    }
  } else if (!hasExpectedPrimaryKey || inlinePrimary.length > 0) {
    throw new Error(
      `Adopted table "${tableName}" must use the composite primary key (${expected.join(', ')})`,
    )
  }
  if (
    !['integer', 'text', 'uuid'].includes(normalizedIdentitySqlType(logicalColumn.getSQLType()))
  ) {
    throw new Error(
      `Adopted table "${tableName}" logical identity "${logicalColumn.name}" must be an integer, text, or uuid`,
    )
  }
}

function assertAdoptedRevision(
  table: AnyPgTable,
  revisionProperty: string | undefined,
  logicalPrimaryKey: string,
  tenantProperty: string,
): void {
  if (!revisionProperty) return
  const tableName = getTableName(table)
  if (revisionProperty === logicalPrimaryKey || revisionProperty === tenantProperty) {
    throw new Error(
      `Adopted table "${tableName}" revision property must not be part of its identity`,
    )
  }
  const revision = adoptedColumn(table, revisionProperty)
  if (!revision.notNull || normalizedIdentitySqlType(revision.getSQLType()) !== 'integer') {
    throw new Error(
      `Adopted table "${tableName}" revision property "${revisionProperty}" must be a required integer`,
    )
  }
}

function assertAdoptedSoftDelete(
  table: AnyPgTable,
  softDeleteProperty: string | undefined,
  logicalPrimaryKey: string,
  tenantProperty: string,
  revisionProperty: string | undefined,
): void {
  if (!softDeleteProperty) return
  const tableName = getTableName(table)
  if (
    softDeleteProperty === logicalPrimaryKey ||
    softDeleteProperty === tenantProperty ||
    softDeleteProperty === revisionProperty
  ) {
    throw new Error(
      `Adopted table "${tableName}" soft-delete property must not be an identity or revision property`,
    )
  }
  const deletedAt = adoptedColumn(table, softDeleteProperty)
  if (
    deletedAt.notNull ||
    deletedAt.hasDefault === true ||
    !normalizedIdentitySqlType(deletedAt.getSQLType()).startsWith('timestamp')
  ) {
    throw new Error(
      `Adopted table "${tableName}" soft-delete property "${softDeleteProperty}" must be a nullable timestamp without a default`,
    )
  }
  const config = getTableConfig(table)
  const constrained =
    deletedAt.primary ||
    deletedAt.isUnique ||
    config.primaryKeys.some((key) =>
      key.columns.some((column) => column.name === deletedAt.name),
    ) ||
    config.uniqueConstraints.some((constraint) =>
      constraint.columns.some((column) => column.name === deletedAt.name),
    ) ||
    config.indexes.some(
      (index) =>
        index.config.unique &&
        index.config.columns.some((column) => 'name' in column && column.name === deletedAt.name),
    ) ||
    config.foreignKeys.some((foreignKey) =>
      foreignKey.reference().columns.some((column) => column.name === deletedAt.name),
    )
  if (constrained) {
    throw new Error(
      `Adopted table "${tableName}" soft-delete property "${softDeleteProperty}" cannot be an identity, unique, or foreign-key column`,
    )
  }
}

function assertAdoptedForeignKeys(
  entries: Array<{
    table: AnyPgTable
    capabilities: TableCapabilities
  }>,
): void {
  const adopted = new Map(entries.map((entry) => [entry.table, entry]))
  for (const child of entries) {
    const childTenant = child.capabilities.tenancy!
    for (const foreignKey of getTableConfig(child.table).foreignKeys) {
      const reference = foreignKey.reference()
      const parent = adopted.get(reference.foreignTable as AnyPgTable)
      if (!parent) continue
      const parentTenant = parent.capabilities.tenancy!
      const tenantIndex = reference.columns.findIndex(
        (column) => column.name === childTenant.column,
      )
      if (tenantIndex < 0 || reference.foreignColumns[tenantIndex]?.name !== parentTenant.column) {
        throw new Error(
          `Tenant foreign key from "${getTableName(child.table)}" to "${getTableName(parent.table)}" must include tenant column "${childTenant.column}"`,
        )
      }
      const onDelete = foreignKey.onDelete
      if (parent.capabilities.draftable && (onDelete === 'cascade' || onDelete === 'set null')) {
        throw new Error(
          `Tenant foreign key from "${getTableName(child.table)}" cannot use ON DELETE ${onDelete.toUpperCase()} because "${getTableName(parent.table)}" is draftable`,
        )
      }
    }
  }
}

/**
 * Attach WyStack custody to an existing Drizzle schema without defining a
 * second set of tables. Adoption is deliberately strict: the physical schema
 * must already encode tenant-qualified identity and every adopted-to-adopted
 * foreign key must carry the same tenant column.
 */
export function adoptSchema<
  TDescriptor extends MultiTenantDescriptor<TenantKeyDefinition>,
  const TTables extends Record<string, AdoptedTableConfig>,
>(descriptor: TDescriptor, tables: TTables): AdoptedSchema<TDescriptor, TTables> {
  const tenancy = getTenantCapability(descriptor)
  const entriesByTable = new Map<AnyPgTable, AdoptedEntry>()
  const namedEntries = Object.entries(tables).map(([name, config]) => {
    const capabilities: TableCapabilities = {
      draftable: config.draftable === true,
      tenancy,
      ...(config.revisionProperty ? { revisionProperty: config.revisionProperty } : {}),
      ...(config.softDeleteProperty ? { softDeleteProperty: config.softDeleteProperty } : {}),
    }
    const entry: AdoptedEntry = {
      table: config.table,
      capabilities,
      identity: config.identity ?? 'tenant-primary',
      logicalPrimaryKeyProperty: config.logicalPrimaryKey,
      logicalPrimaryKeyColumn: adoptedColumn(config.table, config.logicalPrimaryKey).name,
    }
    const previous = entriesByTable.get(config.table)
    if (previous) {
      if (!sameAdoptedRegistration(previous, entry)) {
        throw new Error(
          `Adopted table "${getTableName(config.table)}" is configured more than once with a different adoption contract`,
        )
      }
      return [name, previous] as const
    }
    entriesByTable.set(config.table, entry)
    return [name, entry] as const
  })
  const entries = [...entriesByTable.values()]

  for (const entry of entries) {
    assertAdoptedIdentity(entry.table, entry.logicalPrimaryKeyProperty, tenancy, entry.identity)
    assertAdoptedRevision(
      entry.table,
      entry.capabilities.revisionProperty,
      entry.logicalPrimaryKeyProperty,
      tenancy.property,
    )
    assertAdoptedSoftDelete(
      entry.table,
      entry.capabilities.softDeleteProperty,
      entry.logicalPrimaryKeyProperty,
      tenancy.property,
      entry.capabilities.revisionProperty,
    )
    const previous = adoptedRegistrations.get(entry.table)
    if (previous && !sameAdoptedRegistration(previous, entry)) {
      throw new Error(
        `Adopted table "${getTableName(entry.table)}" is already registered with different capabilities`,
      )
    }
  }
  const completeAdoptedGraph = new Map(
    [...adoptedRegistrations].map(([table, registration]) => [
      table,
      { table, capabilities: registration.capabilities },
    ]),
  )
  for (const entry of entries) completeAdoptedGraph.set(entry.table, entry)
  assertAdoptedForeignKeys([...completeAdoptedGraph.values()])

  for (const entry of entries) {
    registerTableCapabilities(entry.table, entry.capabilities)
    logicalPrimaryKeyColumns.set(entry.table, entry.logicalPrimaryKeyColumn)
    adoptedRegistrations.set(entry.table, {
      capabilities: Object.freeze({
        ...entry.capabilities,
        tenancy: entry.capabilities.tenancy
          ? Object.freeze({ ...entry.capabilities.tenancy })
          : undefined,
      }),
      identity: entry.identity,
      logicalPrimaryKeyProperty: entry.logicalPrimaryKeyProperty,
      logicalPrimaryKeyColumn: entry.logicalPrimaryKeyColumn,
    })
  }
  const adopted = Object.fromEntries(
    namedEntries.map(([name, entry]) => [name, entry.table]),
  ) as AdoptedSchema<TDescriptor, TTables>

  generatedTables.set(adopted, [
    ...(entries.some((entry) => entry.capabilities.draftable) ? [buildDraftChangesTable()] : []),
    ...(entries.some((entry) => entry.capabilities.revisionProperty)
      ? [buildRowRevisionsTable()]
      : []),
  ])
  return adopted
}
