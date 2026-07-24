import type { DrizzleTracker, AnyColumnDef, ColumnDef, InferColumn, DbConfig } from '@wystack/db'
import type { Permission } from '@wystack/permissions'

/** Replaces properties in T with the corresponding properties from U. */
export type Overwrite<T, U> = Omit<T, keyof U> & U

/** The only value a middleware stage may return to continue the procedure. */
export const stageOkBrand: unique symbol = Symbol('StageOk')

export interface StageOk<TPatch> {
  readonly [stageOkBrand]: true
  readonly patch: TPatch
}

export type MiddlewareFn<TCtxIn, TPatch> = (opts: {
  ctx: TCtxIn
  next: <P = {}>(patch?: P) => StageOk<P>
}) => StageOk<TPatch> | Promise<StageOk<TPatch>>

/** Boolean permission probe: denials return false; policy errors propagate. */
// oxlint-disable-next-line typescript/no-explicit-any -- permissions remain contravariant over app-specific contexts
export type Can = (permission: Permission<any>) => Promise<boolean>

/** Function context passed to every query/mutation handler. */
export type FunctionContext<TAppContext extends object = Record<string, unknown>> = TAppContext & {
  db: DrizzleTracker
  can: Can
}

/**
 * Maps a DSL ColumnDef to its TypeScript arg type, honoring optionality:
 * `text.optional()` becomes `T | undefined`, not a required `T`. Delegates to
 * `@wystack/db`'s `InferColumn` so column-type inference has a single source of
 * truth (the DSL package owns the ColumnDef optional-flag convention).
 */
export type InferArg<C> = InferColumn<C>

/** True when a ColumnDef carries the optional flag (`.optional()`). */
type IsOptionalColumn<C> = C extends ColumnDef<unknown, infer Opt> ? Opt : false

/**
 * Maps a table of DSL columns to a procedure's arg object, honoring optionality
 * at the KEY level: `.optional()` columns become omittable (`key?`), not merely
 * `key: T | undefined`. This lets callers pass `{ id, ...partial }` or omit an
 * optional arg entirely, matching what runtime validation already accepts —
 * without an escape hatch that erases the arg type.
 */
export type InferArgs<T extends Record<string, AnyColumnDef>> = {
  [K in keyof T as IsOptionalColumn<T[K]> extends true ? never : K]: InferArg<T[K]>
} & {
  [K in keyof T as IsOptionalColumn<T[K]> extends true ? K : never]?: InferArg<T[K]>
}

// oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
export interface QueryDef<TArgs = any, TReturn = any> {
  type: 'query'
  path: string
  args: Record<string, AnyColumnDef>
  // oxlint-disable-next-line typescript/no-explicit-any -- load-bearing FunctionDef storage shape
  handler: (ctx: any, args: TArgs) => Promise<TReturn>
}

// oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
export interface MutationDef<TArgs = any, TReturn = any> {
  type: 'mutation'
  path: string
  args: Record<string, AnyColumnDef>
  // oxlint-disable-next-line typescript/no-explicit-any -- load-bearing FunctionDef storage shape
  handler: (ctx: any, args: TArgs) => Promise<TReturn>
}

export type FunctionDef = QueryDef | MutationDef

/** DB connection input — string URL, config object, or pre-built Drizzle instance (for tests) */
export type DbInput = string | DbConfig | object

export interface WyStackServer {
  port: number
  stop(immediate?: boolean): void
}
