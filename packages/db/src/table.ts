import { uuid, type AnyColumnDef } from './dsl'

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

function freezeCapabilities(capabilities: TableCapabilities): Readonly<TableCapabilities> {
  const tenancy = capabilities.tenancy ? Object.freeze({ ...capabilities.tenancy }) : undefined
  return Object.freeze({ ...capabilities, tenancy })
}

export class TableDefinition<
  TColumns extends ColumnDefinitions = ColumnDefinitions,
  TDraftable extends boolean = false,
  TSystemManaged extends string = never,
  TRevisionProperty extends string = never,
> {
  declare readonly [systemManagedProperties]: TSystemManaged
  readonly columns: TColumns
  readonly capabilities: Readonly<TableCapabilities> & { readonly draftable: TDraftable }

  constructor(columns: TColumns, capabilities: TableCapabilities & { draftable: TDraftable }) {
    this.columns = columns
    this.capabilities = freezeCapabilities(capabilities) as Readonly<TableCapabilities> & {
      readonly draftable: TDraftable
    }
  }

  draftable(): TableDefinition<TColumns, true, TSystemManaged, TRevisionProperty> {
    return new TableDefinition<TColumns, true, TSystemManaged, TRevisionProperty>(this.columns, {
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
    return new TableDefinition<TColumns, TDraftable, TSystemManaged | TKey, TKey>(this.columns, {
      ...this.capabilities,
      revisionProperty: property,
    })
  }
}

export function table<TColumns extends ColumnDefinitions>(
  columns: TColumns,
): TableDefinition<TColumns, false> {
  return new TableDefinition(columns, { draftable: false })
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
  const key = Object.freeze({ ...opts.key })
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
      return new TableDefinition(withTenant, {
        draftable: false,
        tenancy: { ...key, descriptorId },
      })
    },
  })
}
