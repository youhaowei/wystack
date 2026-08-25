import { uuid, type AnyColumnDef } from './dsl'

export type ColumnDefinitions = Record<string, AnyColumnDef>

export interface TenantKeyDefinition<
  TProperty extends string = string,
  TColumn extends string = string,
  TType extends AnyColumnDef = AnyColumnDef,
> {
  property: TProperty
  column: TColumn
  type: TType
}

export interface TenantCapability extends TenantKeyDefinition {
  readonly descriptorId: symbol
}

export interface TableCapabilities {
  draftable: boolean
  tenancy?: TenantCapability
  revisionProperty?: string
}

export class TableDefinition<
  TColumns extends ColumnDefinitions = ColumnDefinitions,
  TDraftable extends boolean = false,
> {
  readonly columns: TColumns
  readonly capabilities: TableCapabilities & { draftable: TDraftable }

  constructor(columns: TColumns, capabilities: TableCapabilities & { draftable: TDraftable }) {
    this.columns = columns
    this.capabilities = capabilities
  }

  draftable(): TableDefinition<TColumns, true> {
    return new TableDefinition(this.columns, { ...this.capabilities, draftable: true })
  }

  revision<TKey extends Extract<keyof TColumns, string>>(
    property: TKey,
  ): TableDefinition<TColumns, TDraftable> {
    const definition = this.columns[property]
    if (!definition) throw new Error(`Unknown revision property "${property}"`)
    if (definition.opts.isArray || definition.opts.isOptional || definition.opts.isNullable) {
      throw new Error(`Revision property "${property}" must be a required, non-null scalar`)
    }
    return new TableDefinition(this.columns, {
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
  ): TableDefinition<WithTenantKey<TColumns, TKey>, false>
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
  const { key } = opts
  if (key.property.length === 0) throw new Error('multiTenant key.property cannot be empty')
  if (key.column.length === 0) throw new Error('multiTenant key.column cannot be empty')
  if (key.type.opts.isOptional || key.type.opts.isNullable) {
    throw new Error('multiTenant key.type must be required and non-nullable')
  }
  if (key.type.opts.isArray || !['text', 'uuid', 'int'].includes(key.type.opts.type)) {
    throw new Error('multiTenant key.type must be a scalar text, uuid, or int column')
  }
  const descriptorId = Symbol('multiTenant descriptor')

  return {
    key,
    table<TColumns extends ColumnDefinitions>(columns: TColumns) {
      if (Object.hasOwn(columns, key.property)) {
        throw new Error(
          `multiTenant table cannot declare tenant property "${key.property}"; it is injected by the tenancy descriptor`,
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
  }
}
