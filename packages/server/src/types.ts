import type { TrackedDb, ColumnDef } from '@wystack/db'

export interface FunctionContext {
  db: TrackedDb
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
