import type { DrizzleTracker, AnyColumnDef, ColumnDef, DbConfig } from '@wystack/db'

/** Function context passed to every query/mutation handler.
 *  `db` is always provided by WyStack.
 *  App-defined context (auth, tenant info) is merged in via createWyStack's generic. */
export interface FunctionContext {
  db: DrizzleTracker
  [key: string]: unknown
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
  handler: (ctx: FunctionContext, args: TArgs) => Promise<TReturn>
}

// oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
export interface MutationDef<TArgs = any, TReturn = any> {
  type: 'mutation'
  path: string
  args: Record<string, AnyColumnDef>
  handler: (ctx: FunctionContext, args: TArgs) => Promise<TReturn>
}

export type FunctionDef = QueryDef | MutationDef

/** DB connection input — string URL, config object, or pre-built Drizzle instance (for tests) */
export type DbInput = string | DbConfig | object

export interface WyStackServer {
  port: number
  stop(immediate?: boolean): void
}
