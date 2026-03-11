import type { FunctionContext, QueryDef, MutationDef } from './types'

interface ArgSchema {
  args: Record<string, string>
}

/**
 * Define a reactive query. The server tracks which tables this reads
 * and re-runs it when relevant mutations fire.
 */
export function query<TArgs, TReturn>(
  schema: { args: Record<string, string> },
  handler: (ctx: FunctionContext, args: TArgs) => Promise<TReturn>,
): QueryDef<TArgs, TReturn> {
  return {
    type: 'query',
    path: '', // set by registry
    args: {} as TArgs,
    handler,
    tablesRead: new Set(),
  }
}

/**
 * Define a mutation. The server tracks which tables this writes to
 * and invalidates subscribed queries.
 */
export function mutation<TArgs, TReturn>(
  schema: { args: Record<string, string> },
  handler: (ctx: FunctionContext, args: TArgs) => Promise<TReturn>,
): MutationDef<TArgs, TReturn> {
  return {
    type: 'mutation',
    path: '', // set by registry
    args: {} as TArgs,
    handler,
    tablesWritten: new Set(),
  }
}
