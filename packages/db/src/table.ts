import type { AnyColumnDef } from './dsl'

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

export interface TableCapabilities {
  draftable: boolean
  tenancy?: TenantKeyDefinition
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

export function multiTenant<const TKey extends TenantKeyDefinition>(opts: {
  key: TKey
}): MultiTenantDescriptor<TKey> {
  const { key } = opts
  if (key.property.length === 0) throw new Error('multiTenant key.property cannot be empty')
  if (key.column.length === 0) throw new Error('multiTenant key.column cannot be empty')
  if (key.type.opts.isOptional || key.type.opts.isNullable) {
    throw new Error('multiTenant key.type must be required and non-nullable')
  }

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
      } as WithTenantKey<TColumns, TKey>
      return new TableDefinition(withTenant, { draftable: false, tenancy: key })
    },
  }
}
