/**
 * WyStack Schema DSL — chainable column descriptors that map to Drizzle column types.
 * Each modifier returns a new immutable instance.
 */

export type ColumnType = 'text' | 'int' | 'boolean' | 'timestamp' | 'jsonb'

export interface ColumnDefOptions {
  type: ColumnType
  isOptional: boolean
  hasDefault: boolean
  defaultValue?: unknown
  isPrimaryKey: boolean
  isUnique: boolean
}

export class ColumnDef<TType = unknown, TOptional extends boolean = false> {
  readonly _type!: TType
  readonly _optional!: TOptional
  readonly opts: ColumnDefOptions

  constructor(opts: ColumnDefOptions) {
    this.opts = opts
  }

  optional(): ColumnDef<TType, true> {
    return new ColumnDef({ ...this.opts, isOptional: true })
  }

  default(value: TType): ColumnDef<TType, TOptional> {
    return new ColumnDef({ ...this.opts, hasDefault: true, defaultValue: value })
  }

  primaryKey(): ColumnDef<TType, TOptional> {
    return new ColumnDef({ ...this.opts, isPrimaryKey: true })
  }

  unique(): ColumnDef<TType, TOptional> {
    return new ColumnDef({ ...this.opts, isUnique: true })
  }
}

function col<T>(type: ColumnType): ColumnDef<T, false> {
  return new ColumnDef({
    type,
    isOptional: false,
    hasDefault: false,
    isPrimaryKey: false,
    isUnique: false,
  })
}

export const text = col<string>('text')
export const int = col<number>('int')
export const boolean = col<boolean>('boolean')
export const timestamp = col<Date>('timestamp')
export const jsonb = col<unknown>('jsonb')

/** Infer the TypeScript type for a column: optional columns become T | undefined */
export type InferColumn<C> = C extends ColumnDef<infer T, infer Opt>
  ? Opt extends true ? T | undefined : T
  : never

/** Infer the TypeScript type for a table definition */
export type InferTable<T extends Record<string, ColumnDef>> = {
  [K in keyof T]: InferColumn<T[K]>
}
