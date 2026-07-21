import type { DrizzleTracker, AnyColumnDef, ColumnDef, DbConfig } from '@wystack/db'
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

/** Maps DSL ColumnDef types to TypeScript types for arg validation */
// oxlint-disable-next-line typescript/no-explicit-any -- `any` required for `infer` to extract phantom type
export type InferArg<C> = C extends ColumnDef<infer T, any> ? T : never

export type InferArgs<T extends Record<string, AnyColumnDef>> = {
  [K in keyof T]: InferArg<T[K]>
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
