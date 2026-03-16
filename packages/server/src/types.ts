import type { TrackedDb, ColumnDef, DbConfig } from '@wystack/db'

/** Function context passed to every query/mutation handler.
 *  `db` is always provided by WyStack.
 *  App-defined context (auth, tenant info) is merged in via createWyStack's generic. */
export interface FunctionContext {
  db: TrackedDb
  [key: string]: any
}

/** Maps DSL ColumnDef types to TypeScript types for arg validation */
export type InferArg<C> = C extends ColumnDef<infer T, any> ? T : never

export type InferArgs<T extends Record<string, ColumnDef<any, any>>> = {
  [K in keyof T]: InferArg<T[K]>
}

export interface QueryDef<TArgs = any, TReturn = any> {
  type: 'query'
  path: string
  args: Record<string, ColumnDef<any, any>>
  handler: (ctx: FunctionContext, args: TArgs) => Promise<TReturn>
}

export interface MutationDef<TArgs = any, TReturn = any> {
  type: 'mutation'
  path: string
  args: Record<string, ColumnDef<any, any>>
  handler: (ctx: FunctionContext, args: TArgs) => Promise<TReturn>
}

export type FunctionDef = QueryDef | MutationDef

/** DB connection input — string URL, config object, or pre-built Drizzle instance (for tests) */
export type DbInput = string | DbConfig | object
