/**
 * WyStack Schema DSL — chainable column descriptors that map to Drizzle column types.
 * Each modifier returns a new immutable instance.
 */

export type ColumnType = 'text' | 'int' | 'boolean' | 'timestamp' | 'jsonb' | 'uuid'

export interface RefOptions {
  table: string
  column: string
  onDelete?: 'cascade' | 'set null' | 'no action'
  withinTenant?: boolean
}

export interface ColumnDefOptions {
  type: ColumnType
  isOptional: boolean
  isNullable: boolean
  hasDefault: boolean
  defaultValue?: unknown
  isDefaultRandom: boolean
  isDefaultNow: boolean
  isPrimaryKey: boolean
  isUnique: boolean
  isUniqueWithinTenant: boolean
  isArray: boolean
  ref?: RefOptions
}

export class ColumnDef<
  TType = unknown,
  TOptional extends boolean = false,
  TNullable extends boolean = false,
> {
  readonly _type!: TType
  readonly _optional!: TOptional
  readonly _nullable!: TNullable
  readonly opts: ColumnDefOptions

  constructor(opts: ColumnDefOptions) {
    this.opts = opts
  }

  optional(): ColumnDef<TType, true, TNullable> {
    return new ColumnDef({ ...this.opts, isOptional: true })
  }

  nullable(): ColumnDef<TType, TOptional, true> {
    return new ColumnDef({ ...this.opts, isNullable: true })
  }

  default(value: TType): ColumnDef<TType, TOptional, TNullable> {
    return new ColumnDef({ ...this.opts, hasDefault: true, defaultValue: value })
  }

  /** UUID: gen_random_uuid() default */
  defaultRandom(): ColumnDef<TType, TOptional, TNullable> {
    return new ColumnDef({ ...this.opts, isDefaultRandom: true, hasDefault: true })
  }

  /** Timestamp: DEFAULT NOW() */
  defaultNow(): ColumnDef<TType, TOptional, TNullable> {
    return new ColumnDef({ ...this.opts, isDefaultNow: true, hasDefault: true })
  }

  primaryKey(): ColumnDef<TType, TOptional, TNullable> {
    return new ColumnDef({ ...this.opts, isPrimaryKey: true })
  }

  unique(): ColumnDef<TType, TOptional, TNullable> {
    return new ColumnDef({ ...this.opts, isUnique: true })
  }

  uniqueWithinTenant(): ColumnDef<TType, TOptional, TNullable> {
    return new ColumnDef({ ...this.opts, isUniqueWithinTenant: true })
  }

  /** Foreign key reference: .references('tableName') or .references('tableName', 'columnName') */
  references(
    table: string,
    column: string = 'id',
    onDelete?: 'cascade' | 'set null' | 'no action',
  ): ColumnDef<TType, TOptional, TNullable> {
    return new ColumnDef({ ...this.opts, ref: { table, column, onDelete } })
  }

  referencesWithinTenant(
    table: string,
    column: string = 'id',
    onDelete?: 'cascade' | 'set null' | 'no action',
  ): ColumnDef<TType, TOptional, TNullable> {
    return new ColumnDef({
      ...this.opts,
      ref: { table, column, onDelete, withinTenant: true },
    })
  }

  /** Array column: text.array() → TEXT[] */
  array(): ColumnDef<TType[], TOptional, TNullable> {
    return new ColumnDef({ ...this.opts, isArray: true })
  }
}

function col<T>(type: ColumnType): ColumnDef<T, false> {
  return new ColumnDef({
    type,
    isOptional: false,
    isNullable: false,
    hasDefault: false,
    isDefaultRandom: false,
    isDefaultNow: false,
    isPrimaryKey: false,
    isUnique: false,
    isUniqueWithinTenant: false,
    isArray: false,
  })
}

export const text = col<string>('text')
export const int = col<number>('int')
export const boolean = col<boolean>('boolean')
export const timestamp = col<Date>('timestamp')
export const jsonb = col<unknown>('jsonb')
export const uuid = col<string>('uuid')

/** Wildcard type for ColumnDef in generic constraints where type params don't matter.
 *  Uses `any` because TypeScript's `extends` constraint + `infer` require it for correct inference. */
// oxlint-disable-next-line typescript/no-explicit-any
export type AnyColumnDef = ColumnDef<any, any, any>

/** Infer the TypeScript type, independently preserving optional and nullable semantics. */
export type InferColumn<C> =
  C extends ColumnDef<infer T, infer Opt, infer Nullable>
    ? T | (Opt extends true ? undefined : never) | (Nullable extends true ? null : never)
    : never

/** Infer the TypeScript type for a table definition */
export type InferTable<T extends Record<string, ColumnDef>> = {
  [K in keyof T]: InferColumn<T[K]>
}
