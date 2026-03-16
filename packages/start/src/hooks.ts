import { useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient, type UseQueryResult, type UseMutationResult } from '@tanstack/react-query'
import { useWyStartClient } from './provider'

let subIdCounter = 0
function nextSubId() {
  return `wy_${++subIdCounter}`
}

/**
 * useWyQuery — fetches data via HTTP GET (React Query), subscribes via WS for
 * live invalidation. Returns a standard React Query result.
 *
 * SSR flow: pair with wyLoader() in route loader for SSR hydration.
 */
export function useWyQuery<T = any>(
  path: string,
  args?: any,
): UseQueryResult<T> {
  const client = useWyStartClient()
  const queryClient = useQueryClient()
  const subIdRef = useRef<string | null>(null)

  const queryKey = args !== undefined
    ? ['wystack', path, args]
    : ['wystack', path]

  // HTTP fetch via React Query
  const query = useQuery<T>({
    queryKey,
    queryFn: () => client.call(path, args),
  })

  // WS subscription for live invalidation
  useEffect(() => {
    const subId = nextSubId()
    subIdRef.current = subId

    client.onInvalidate(subId, path, args ?? {}, () => {
      queryClient.invalidateQueries({ queryKey })
    })

    return () => {
      client.offInvalidate(subId)
    }
  }, [path, JSON.stringify(args)])

  return query
}

/**
 * useWyMutation — calls WyStack mutation via HTTP POST.
 * Returns a standard React Query mutation result.
 * No manual invalidation needed — WS subscription handles it.
 */
export function useWyMutation<TArgs = any, TReturn = any>(
  path: string,
): UseMutationResult<TReturn, Error, TArgs> {
  const client = useWyStartClient()

  return useMutation<TReturn, Error, TArgs>({
    mutationFn: (args: TArgs) => client.call(path, args),
  })
}
