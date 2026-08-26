import { ColumnDef, uuid, type AnyColumnDef } from './dsl'

export type ColumnDefinitions = Record<string, AnyColumnDef>

declare const systemManagedProperties: unique symbol

export interface CarriesSystemManagedProperties<TProperties extends string> {
  readonly [systemManagedProperties]: TProperties
}

/** Framework-owned property keys carried only through the type system. */
export type SystemManagedProperties<T> =
  T extends CarriesSystemManagedProperties<infer TProperties> ? TProperties : never

/** Preserve framework-owned keys when a definition is compiled into a Drizzle table. */
export type WithSystemManagedProperties<TTable, TDefinition> = TTable &
  CarriesSystemManagedProperties<SystemManagedProperties<TDefinition>>

export interface TenantKeyDefinition<
  TProperty extends string = string,
  TColumn extends string = string,
  TType extends AnyColumnDef = AnyColumnDef,
> {
  readonly property: TProperty
  readonly column: TColumn
  readonly type: TType
}

export interface TenantCapability extends TenantKeyDefinition {
  readonly descriptorId: symbol
}

export interface TableCapabilities {
  readonly draftable: boolean
  readonly tenancy?: TenantCapability
  readonly revisionProperty?: string
}

const standardColumnDefinitionOwnKeys = new Set(Reflect.ownKeys(uuid))

function snapshotDefaultValue(value: unknown, ancestors: readonly object[] = []): unknown {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('Column default numbers must be finite')
    }
    return value
  }
  if (value instanceof Date) return new Date(value.getTime())
  if (typeof value !== 'object') {
    throw new Error('Column defaults must be primitives, Date values, arrays, or plain objects')
  }
  if (ancestors.includes(value)) {
    throw new Error('Column defaults cannot contain circular references')
  }
  const nestedAncestors = [...ancestors, value]
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((nestedValue) => snapshotDefaultValue(nestedValue, nestedAncestors)),
    )
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error('Column defaults must be primitives, Date values, arrays, or plain objects')
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        snapshotDefaultValue(nestedValue, nestedAncestors),
      ]),
    ),
  )
}

function readDefaultValueSnapshot(value: unknown): unknown {
  if (value instanceof Date) return new Date(value.getTime())
  if (Array.isArray(value)) return Object.freeze(value.map(readDefaultValueSnapshot))
  if (value && typeof value === 'object') {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, nestedValue]) => [
          key,
          readDefaultValueSnapshot(nestedValue),
        ]),
      ),
    )
  }
  return value
}

function snapshotColumnDefinition<TColumn extends AnyColumnDef>(definition: TColumn): TColumn {
  if (Object.getPrototypeOf(definition) !== ColumnDef.prototype) {
    throw new Error(
      'Column definitions must be plain ColumnDef instances; subclasses are unsupported',
    )
  }
  const ownKeys = Reflect.ownKeys(definition)
  if (
    ownKeys.length !== standardColumnDefinitionOwnKeys.size ||
    ownKeys.some((key) => !standardColumnDefinitionOwnKeys.has(key))
  ) {
    throw new Error('Column definitions cannot carry custom own state')
  }
  const opts = { ...definition.opts }
  if (Object.hasOwn(definition.opts, 'defaultValue')) {
    const defaultValueSnapshot = snapshotDefaultValue(definition.opts.defaultValue)
    Object.defineProperty(opts, 'defaultValue', {
      get: () => readDefaultValueSnapshot(defaultValueSnapshot),
      enumerable: true,
      configurable: false,
    })
  }
  if (opts.ref) opts.ref = Object.freeze({ ...opts.ref })

  const snapshot = new ColumnDef(Object.freeze(opts)) as TColumn
  return Object.freeze(snapshot)
}

function snapshotColumns<TColumns extends ColumnDefinitions>(columns: TColumns): TColumns {
  const prototype = Object.getPrototypeOf(columns)
  const ownKeys = Reflect.ownKeys(columns)
  const hasHiddenOrSymbolKeys = ownKeys.some(
    (key) =>
      typeof key !== 'string' || Object.getOwnPropertyDescriptor(columns, key)?.enumerable !== true,
  )
  if ((prototype !== Object.prototype && prototype !== null) || hasHiddenOrSymbolKeys) {
    throw new Error('Table columns must be a plain map of enumerable string properties')
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(columns).map(([property, definition]) => [
        property,
        snapshotColumnDefinition(definition),
      ]),
    ),
  ) as TColumns
}

function freezeCapabilities(capabilities: TableCapabilities): Readonly<TableCapabilities> {
  const tenancy = capabilities.tenancy
    ? Object.freeze({
        ...capabilities.tenancy,
        type: snapshotColumnDefinition(capabilities.tenancy.type),
      })
    : undefined
  return Object.freeze({ ...capabilities, tenancy })
}

const tableDefinitionConstructionToken = Symbol('TableDefinition construction token')

type CreateTableDefinition = <
  TColumns extends ColumnDefinitions,
  TDraftable extends boolean,
  TSystemManaged extends string,
  TRevisionProperty extends string,
>(
  columns: TColumns,
  capabilities: TableCapabilities & { draftable: TDraftable },
) => TableDefinition<TColumns, TDraftable, TSystemManaged, TRevisionProperty>

let createTableDefinition: CreateTableDefinition

export class TableDefinition<
  TColumns extends ColumnDefinitions = ColumnDefinitions,
  TDraftable extends boolean = false,
  TSystemManaged extends string = never,
  TRevisionProperty extends string = never,
> {
  readonly #constructionBrand = tableDefinitionConstructionToken
  declare readonly [systemManagedProperties]: TSystemManaged
  readonly columns: TColumns
  readonly capabilities: Readonly<TableCapabilities> & { readonly draftable: TDraftable }

  private constructor(
    token: typeof tableDefinitionConstructionToken,
    columns: TColumns,
    capabilities: TableCapabilities & { draftable: TDraftable },
  ) {
    if (token !== tableDefinitionConstructionToken) {
      throw new Error('TableDefinition cannot be constructed directly; use table(...)')
    }
    this.columns = snapshotColumns(columns)
    this.capabilities = freezeCapabilities(capabilities) as Readonly<TableCapabilities> & {
      readonly draftable: TDraftable
    }
    Object.freeze(this)
  }

  static [Symbol.hasInstance](value: unknown): boolean {
    return (
      typeof value === 'object' &&
      value !== null &&
      #constructionBrand in value &&
      value.#constructionBrand === tableDefinitionConstructionToken
    )
  }

  static #assertAuthentic(value: object): void {
    if (
      !(#constructionBrand in value) ||
      value.#constructionBrand !== tableDefinitionConstructionToken
    ) {
      throw new Error('TableDefinition capability methods require a factory-created definition')
    }
  }

  static {
    createTableDefinition = <
      TColumns extends ColumnDefinitions,
      TDraftable extends boolean,
      TSystemManaged extends string,
      TRevisionProperty extends string,
    >(
      columns: TColumns,
      capabilities: TableCapabilities & { draftable: TDraftable },
    ): TableDefinition<TColumns, TDraftable, TSystemManaged, TRevisionProperty> =>
      new TableDefinition<TColumns, TDraftable, TSystemManaged, TRevisionProperty>(
        tableDefinitionConstructionToken,
        columns,
        capabilities,
      )
  }

  draftable(): TableDefinition<TColumns, true, TSystemManaged, TRevisionProperty> {
    TableDefinition.#assertAuthentic(this)
    return createTableDefinition<TColumns, true, TSystemManaged, TRevisionProperty>(this.columns, {
      ...this.capabilities,
      draftable: true,
    })
  }

  revision<TKey extends Extract<keyof TColumns, string>>(
    this: [TRevisionProperty] extends [never]
      ? TableDefinition<TColumns, TDraftable, TSystemManaged, TRevisionProperty>
      : never,
    property: TKey,
  ): TableDefinition<TColumns, TDraftable, TSystemManaged | TKey, TKey> {
    TableDefinition.#assertAuthentic(this)
    if (this.capabilities.revisionProperty) {
      throw new Error(
        `Revision property is already configured as "${this.capabilities.revisionProperty}"`,
      )
    }
    const definition = this.columns[property]
    if (!definition) throw new Error(`Unknown revision property "${property}"`)
    if (this.capabilities.tenancy?.property === property) {
      throw new Error(`Revision property "${property}" cannot be the tenant key`)
    }
    if (definition.opts.isPrimaryKey) {
      throw new Error(`Revision property "${property}" cannot be a primary key`)
    }
    if (definition.opts.isUnique || definition.opts.isUniqueWithinTenant) {
      throw new Error(`Revision property "${property}" cannot be unique`)
    }
    if (definition.opts.ref) {
      throw new Error(`Revision property "${property}" cannot be a foreign key`)
    }
    if (definition.opts.isArray || definition.opts.isOptional || definition.opts.isNullable) {
      throw new Error(`Revision property "${property}" must be a required, non-null scalar`)
    }
    if (definition.opts.type !== 'int') {
      throw new Error(`Revision property "${property}" must be an integer`)
    }
    return createTableDefinition<TColumns, TDraftable, TSystemManaged | TKey, TKey>(this.columns, {
      ...this.capabilities,
      revisionProperty: property,
    })
  }
}

Object.defineProperty(TableDefinition, Symbol.hasInstance, {
  value: TableDefinition[Symbol.hasInstance],
  configurable: false,
  writable: false,
})

export function table<TColumns extends ColumnDefinitions>(
  columns: TColumns,
): TableDefinition<TColumns, false> {
  return createTableDefinition<TColumns, false, never, never>(columns, {
    draftable: false,
  })
}

type WithTenantKey<
  TColumns extends ColumnDefinitions,
  TKey extends TenantKeyDefinition,
> = TColumns & Record<TKey['property'], TKey['type']>

export interface MultiTenantDescriptor<TKey extends TenantKeyDefinition> {
  readonly key: TKey
  table<TColumns extends ColumnDefinitions>(
    columns: TKey['property'] extends keyof TColumns ? never : TColumns,
  ): TableDefinition<WithTenantKey<TColumns, TKey>, false, TKey['property']>
}

const defaultTenantKey = {
  property: 'tenantId',
  column: 'tenant_id',
  type: uuid,
} as const

export function multiTenant(): MultiTenantDescriptor<typeof defaultTenantKey>
export function multiTenant<const TKey extends TenantKeyDefinition>(opts: {
  key: TKey
}): MultiTenantDescriptor<TKey>
export function multiTenant(
  opts: { key: TenantKeyDefinition } = { key: defaultTenantKey },
): MultiTenantDescriptor<TenantKeyDefinition> {
  const key = Object.freeze({
    ...opts.key,
    type: snapshotColumnDefinition(opts.key.type),
  })
  if (key.property.length === 0) throw new Error('multiTenant key.property cannot be empty')
  if (key.column.length === 0) throw new Error('multiTenant key.column cannot be empty')
  if (key.type.opts.isOptional || key.type.opts.isNullable) {
    throw new Error('multiTenant key.type must be required and non-nullable')
  }
  if (key.type.opts.isArray || !['text', 'uuid', 'int'].includes(key.type.opts.type)) {
    throw new Error('multiTenant key.type must be a scalar text, uuid, or int column')
  }
  const descriptorId = Symbol('multiTenant descriptor')

  return Object.freeze({
    key,
    table<TColumns extends ColumnDefinitions>(columns: TColumns) {
      if (Object.hasOwn(columns, key.property)) {
        throw new Error(
          `multiTenant table cannot declare tenant property "${key.property}"; it is injected by the tenancy descriptor`,
        )
      }
      if (key.column !== key.property && Object.hasOwn(columns, key.column)) {
        throw new Error(
          `multiTenant table cannot declare SQL column "${key.column}"; it is reserved for the injected tenant key`,
        )
      }
      const withTenant = {
        ...columns,
        [key.property]: key.type,
      } as WithTenantKey<TColumns, TenantKeyDefinition>
      return createTableDefinition(withTenant, {
        draftable: false,
        tenancy: { ...key, descriptorId },
      })
    },
  })
}
