import { useEffect, useMemo } from 'react'
import {
  useQuery as useTanstackQuery,
  useMutation as useTanstackMutation,
  useQueryClient,
} from '@tanstack/react-query'
import type {
  UseQueryResult,
  UseQueryOptions,
  UseMutationResult,
  UseMutationOptions,
} from '@tanstack/react-query'
import type { QueryRef, MutationRef } from './refs'
import { useWyStackClient } from './provider'

function nextSubId() {
  return `wy_${crypto.randomUUID()}`
}

/** Sentinel value to disable a query. `useQuery(api.listTodos, 'skip')` */
export type Skip = 'skip'

type WyQueryOptions<TReturn> = Omit<UseQueryOptions<TReturn>, 'queryKey' | 'queryFn'>

/**
 * useQuery — fetches data via HTTP GET (TanStack Query), subscribes via WS
 * for live invalidation. Accepts a typed QueryRef from the api object.
 *
 * Args must be JSON-serializable (no Date/Map/Set/BigInt). Object key order
 * matters for cache identity — use a consistent shape per call site.
 *
 * ```ts
 * const todos = useQuery(api.listTodos, { orgId })
 * const user = useQuery(api.getUser, userId ? { userId } : 'skip')
 * ```
 */
export function useQuery<TArgs, TReturn>(
  ref: QueryRef<TArgs, TReturn>,
  args?: TArgs | Skip,
  options?: WyQueryOptions<TReturn>,
): UseQueryResult<TReturn> {
  const client = useWyStackClient()
  const queryClient = useQueryClient()

  const skip = args === 'skip'
  const resolvedArgs = skip ? undefined : (args as TArgs | undefined)
  const normalizedArgs = (resolvedArgs ?? {}) as TArgs | Record<string, never>

  const stableArgsKey = JSON.stringify(normalizedArgs)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- stableArgsKey is the structural identity
  const stableArgs = useMemo(() => normalizedArgs, [stableArgsKey])

  const path = ref._path
  const queryKey = ['wystack', path, stableArgs] as const

  const query = useTanstackQuery<TReturn>({
    ...options,
    queryKey,
    queryFn: () => client.query(path, stableArgs) as Promise<TReturn>,
    enabled: !skip && (options?.enabled ?? true),
  })

  // WS subscription for live invalidation
  useEffect(() => {
    if (skip) return

    const subId = nextSubId()

    client.ws.subscribe(subId, path, stableArgs, () => {
      queryClient.invalidateQueries({ queryKey: ['wystack', path, stableArgs] })
    })

    return () => {
      client.ws.unsubscribe(subId)
    }
  }, [client.ws, queryClient, path, stableArgs, stableArgsKey, skip])

  return query
}

type WyMutationOptions<TArgs, TReturn> = Omit<
  UseMutationOptions<TReturn, Error, TArgs>,
  'mutationFn'
>

/**
 * useMutation — calls WyStack mutation via HTTP POST.
 * Accepts a typed MutationRef from the api object.
 *
 * ```ts
 * const { mutate } = useMutation(api.createTodo)
 * mutate({ title: 'Buy milk' })
 * ```
 */
export function useMutation<TArgs, TReturn>(
  ref: MutationRef<TArgs, TReturn>,
  options?: WyMutationOptions<TArgs, TReturn>,
): UseMutationResult<TReturn, Error, TArgs> {
  const client = useWyStackClient()

  return useTanstackMutation<TReturn, Error, TArgs>({
    ...options,
    mutationFn: (args: TArgs) => client.mutate(ref._path, args) as Promise<TReturn>,
  })
}
