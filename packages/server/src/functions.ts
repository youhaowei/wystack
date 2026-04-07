import type { AnyColumnDef } from '@wystack/db'
import type { FunctionContext, QueryDef, MutationDef, InferArgs } from './types'

export function query<TArgSchema extends Record<string, AnyColumnDef>, TReturn>(opts: {
  args: TArgSchema
  handler: (ctx: FunctionContext, args: InferArgs<TArgSchema>) => Promise<TReturn>
}): QueryDef<InferArgs<TArgSchema>, TReturn> {
  return {
    type: 'query',
    path: '',
    args: opts.args,
    handler: opts.handler,
  }
}

export function mutation<TArgSchema extends Record<string, AnyColumnDef>, TReturn>(opts: {
  args: TArgSchema
  handler: (ctx: FunctionContext, args: InferArgs<TArgSchema>) => Promise<TReturn>
}): MutationDef<InferArgs<TArgSchema>, TReturn> {
  return {
    type: 'mutation',
    path: '',
    args: opts.args,
    handler: opts.handler,
  }
}
