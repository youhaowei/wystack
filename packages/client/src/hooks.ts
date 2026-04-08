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

// ---------------------------------------------------------------------------
// Skip sentinel
// ---------------------------------------------------------------------------

/** Sentinel value to disable a query. `useQuery(api.listTodos, 'skip')` */
export type Skip = 'skip'

// ---------------------------------------------------------------------------
// Standalone hooks — Convex-style: useQuery(ref, args), useMutation(ref)
// ---------------------------------------------------------------------------

type WyQueryOptions<TReturn> = Omit<UseQueryOptions<TReturn>, 'queryKey' | 'queryFn'>

/**
 * useQuery — fetches data via HTTP GET (TanStack Query), subscribes via WS
 * for live invalidation. Accepts a typed QueryRef from the api object.
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

  const stableArgsKey = JSON.stringify(resolvedArgs)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableArgs = useMemo(() => resolvedArgs, [stableArgsKey])

  const path = ref._path
  const queryKey = stableArgs !== undefined ? ['wystack', path, stableArgs] : ['wystack', path]

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

    client.ws.subscribe(subId, path, stableArgs ?? {}, () => {
      queryClient.invalidateQueries({ queryKey })
    })

    return () => {
      client.ws.unsubscribe(subId)
    }
  }, [client.ws, queryClient, path, stableArgsKey, skip])

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
    mutationFn: (args: TArgs) => client.mutate(ref._path, args) as Promise<TReturn>,
    ...options,
  })
}

// ---------------------------------------------------------------------------
// Legacy string-based hooks — backward compatible, shared query keys
// ---------------------------------------------------------------------------

/**
 * useWyQuery — string-based hook for incremental migration.
 * Produces the same query keys as useQuery(ref), so cache is shared.
 */
export function useWyQuery<T = unknown>(path: string, args?: unknown): UseQueryResult<T> {
  const client = useWyStackClient()
  const queryClient = useQueryClient()

  const stableArgsKey = JSON.stringify(args)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableArgs = useMemo(() => args, [stableArgsKey])

  const queryKey = stableArgs !== undefined ? ['wystack', path, stableArgs] : ['wystack', path]

  const query = useTanstackQuery<T>({
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
 * useWyMutation — string-based hook for incremental migration.
 */
export function useWyMutation<TArgs = unknown, TReturn = unknown>(
  path: string,
): UseMutationResult<TReturn, Error, TArgs> {
  const client = useWyStackClient()

  return useTanstackMutation<TReturn, Error, TArgs>({
    mutationFn: (args: TArgs) => client.mutate(path, args) as Promise<TReturn>,
  })
}
