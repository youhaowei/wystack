import type { Db, DbConfig } from '@wystack/db'

export interface FunctionContext {
  db: Db
}

export interface QueryDef<TArgs = any, TReturn = any> {
  type: 'query'
  path: string
  args: TArgs
  handler: (ctx: FunctionContext, args: TArgs) => Promise<TReturn>
  tablesRead: Set<string>
}

export interface MutationDef<TArgs = any, TReturn = any> {
  type: 'mutation'
  path: string
  args: TArgs
  handler: (ctx: FunctionContext, args: TArgs) => Promise<TReturn>
  tablesWritten: Set<string>
}

export interface WyStackConfig {
  db: DbConfig
}
