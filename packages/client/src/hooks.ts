import { useEffect, useMemo, useRef } from 'react'
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

type WyQueryOptions<TReturn> = Omit<UseQueryOptions<TReturn>, 'queryKey' | 'queryFn'>

/**
 * Configuration for {@link useQuery}.
 *
 * Cache key shape is always `['wystack', path, args ?? {}]` — three elements,
 * including for no-arg queries (the empty object is preserved for stable
 * identity). Imperative cache reads must use the same three-element form:
 *
 * ```ts
 * queryClient.setQueryData(['wystack', 'allTodos', {}], next)
 * ```
 */
export type QueryConfig<TArgs, TReturn> = WyQueryOptions<TReturn> & {
  args?: TArgs | undefined
  skip?: boolean
  onLiveUpdatesError?: (err: Error) => void
}

type EmptyArgs = Record<string, never>

type QueryConfigArg<TArgs, TReturn> = TArgs extends EmptyArgs
  ? [config?: QueryConfig<TArgs, TReturn>]
  : [
      config:
        | (QueryConfig<TArgs, TReturn> & { args: TArgs; skip?: boolean })
        | (QueryConfig<TArgs, TReturn> & { args?: TArgs; skip: true }),
    ]

/**
 * useQuery — fetches data via HTTP GET (TanStack Query), subscribes via WS
 * for live invalidation. Accepts a typed QueryRef from the api object.
 *
 * Args must be JSON-serializable (no Date/Map/Set/BigInt). Object key order
 * matters for cache identity — use a consistent shape per call site.
 *
 * ```ts
 * const todos = useQuery(api.listTodos, { args: { orgId } })
 * const user = useQuery(api.getUser, { args: userId ? { userId } : undefined, skip: !userId })
 * ```
 */
export function useQuery<TArgs, TReturn>(
  ref: QueryRef<TArgs, TReturn>,
  ...[config]: QueryConfigArg<TArgs, TReturn>
): UseQueryResult<TReturn> {
  const client = useWyStackClient()
  const queryClient = useQueryClient()

  const { args, skip = false, onLiveUpdatesError, ...options } = config ?? {}
  const onLiveUpdatesErrorRef = useRef(onLiveUpdatesError)
  onLiveUpdatesErrorRef.current = onLiveUpdatesError
  const normalizedArgs = (args ?? {}) as TArgs | Record<string, never>

  const stableArgsKey = JSON.stringify(normalizedArgs)
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- stableArgsKey is the structural identity
  const stableArgs = useMemo(() => normalizedArgs, [stableArgsKey])

  const path = ref._path
  const queryKey = ['wystack', path, stableArgs] as const

  const query = useTanstackQuery<TReturn>({
    ...options,
    queryKey,
    queryFn: () => client.query(ref, stableArgs as TArgs),
    enabled: !skip && (options?.enabled ?? true),
  })

  // WS subscription for live invalidation
  useEffect(() => {
    if (skip) return

    const subId = nextSubId()

    client.ws.subscribe(
      subId,
      path,
      stableArgs as Record<string, unknown>,
      () => {
        queryClient.invalidateQueries({ queryKey })
      },
      (err) => {
        onLiveUpdatesErrorRef.current?.(err)
        const isDev = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production'
        if (isDev) {
          // eslint-disable-next-line no-console
          console.warn(
            `[wystack] live updates unavailable for "${path}" — query data still loads over HTTP. ${err.message}`,
          )
        }
      },
    )

    return () => {
      client.ws.unsubscribe(subId)
    }
  }, [client.ws, queryClient, path, stableArgs, skip])

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
    mutationFn: (args: TArgs) => client.mutate(ref, args),
  })
}
