import type { UseQueryResult } from './types'

/**
 * Subscribe to a reactive query. Returns data that auto-updates
 * when relevant mutations fire on the server.
 */
export function useQuery<TArgs, TReturn>(
  queryDef: { path: string },
  args: TArgs,
): UseQueryResult<TReturn> {
  // TODO: Wire up TanStack Query + WebSocket subscription
  throw new Error('Not yet implemented')
}

/**
 * Get a mutation function. Supports optimistic updates via TanStack DB.
 */
export function useMutation<TArgs, TReturn>(
  mutationDef: { path: string },
): (args: TArgs) => Promise<TReturn> {
  // TODO: Wire up mutation + optimistic update
  throw new Error('Not yet implemented')
}
