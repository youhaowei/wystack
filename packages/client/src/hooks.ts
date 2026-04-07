import { useEffect, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query'
import { useWyStackClient } from './provider'

function nextSubId() {
  return `wy_${crypto.randomUUID()}`
}

/**
 * useWyQuery — fetches data via HTTP GET (React Query), subscribes via WS for
 * live invalidation. Returns a standard React Query result.
 */
export function useWyQuery<T = unknown>(path: string, args?: unknown): UseQueryResult<T> {
  const client = useWyStackClient()
  const queryClient = useQueryClient()

  const stableArgsKey = JSON.stringify(args)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableArgs = useMemo(() => args, [stableArgsKey])

  const queryKey = stableArgs !== undefined ? ['wystack', path, stableArgs] : ['wystack', path]

  const query = useQuery<T>({
    queryKey,
    queryFn: () => client.query(path, stableArgs) as Promise<T>,
  })

  // WS subscription for live invalidation
  useEffect(() => {
    const subId = nextSubId()

    client.ws.subscribe(subId, path, stableArgs ?? {}, () => {
      queryClient.invalidateQueries({ queryKey })
    })

    return () => {
      client.ws.unsubscribe(subId)
    }
  }, [client.ws, queryClient, path, stableArgsKey])

  return query
}

/**
 * useWyMutation — calls WyStack mutation via HTTP POST.
 * Returns a standard React Query mutation result.
 * No manual invalidation needed — WS subscription handles it.
 */
export function useWyMutation<TArgs = unknown, TReturn = unknown>(
  path: string,
): UseMutationResult<TReturn, Error, TArgs> {
  const client = useWyStackClient()

  return useMutation<TReturn, Error, TArgs>({
    mutationFn: (args: TArgs) => client.mutate(path, args) as Promise<TReturn>,
  })
}
