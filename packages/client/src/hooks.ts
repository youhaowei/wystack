import { useEffect, useRef } from 'react'
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
  const subIdRef = useRef<string | null>(null)

  const queryKey = args !== undefined ? ['wystack', path, args] : ['wystack', path]

  const query = useQuery<T>({
    queryKey,
    queryFn: () => client.query(path, args) as Promise<T>,
  })

  // WS subscription for live invalidation
  useEffect(() => {
    const subId = nextSubId()
    subIdRef.current = subId

    client.ws.subscribe(subId, path, args ?? {}, () => {
      queryClient.invalidateQueries({ queryKey })
    })

    return () => {
      client.ws.unsubscribe(subId)
    }
  }, [path, JSON.stringify(args)])

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
