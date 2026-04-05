import type { UseQueryResult, UseMutationResult } from '@tanstack/react-query'
import type { QueryDef, MutationDef, FunctionDef } from '@wystack/server'
import type { WyStackClientConfig } from './types'
import { createClient } from './client'
import { useWyQuery, useWyMutation } from './hooks'

// ---------------------------------------------------------------------------
// Type utilities — extract args/return from server function definitions
// ---------------------------------------------------------------------------

type InferReturn<T> =
  T extends QueryDef<unknown, infer R> ? R : T extends MutationDef<unknown, infer R> ? R : never

type InferArgs<T> =
  T extends QueryDef<infer A, unknown> ? A : T extends MutationDef<infer A, unknown> ? A : never

interface QueryProxy<TArgs, TReturn> {
  useQuery(args?: TArgs): UseQueryResult<TReturn>
}

interface MutationProxy<TArgs, TReturn> {
  useMutation(): UseMutationResult<TReturn, Error, TArgs>
}

/* oxlint-disable typescript/no-explicit-any -- variance: `any` is needed for conditional type matching with generic interfaces */
type FunctionProxy<T> =
  T extends QueryDef<any, any>
    ? QueryProxy<InferArgs<T>, InferReturn<T>>
    : T extends MutationDef<any, any>
      ? MutationProxy<InferArgs<T>, InferReturn<T>>
      : never
/* oxlint-enable typescript/no-explicit-any */

/** Mapped proxy type — each key from the server function map becomes a typed hook accessor. */
export type ProxyClient<T extends Record<string, FunctionDef>> = {
  [K in keyof T]: FunctionProxy<T[K]>
}

// ---------------------------------------------------------------------------
// Runtime proxy builder
// ---------------------------------------------------------------------------

/**
 * createWyClient — tRPC-style typed proxy over WyStack server functions.
 *
 * Usage:
 * ```ts
 * import type { AppFunctions } from '../server/functions'
 * const api = createWyClient<AppFunctions>({ url: 'http://localhost:3001' })
 * api.listTodos.useQuery()
 * api.addTodo.useMutation()
 * ```
 *
 * The generic `T` is type-only — no server code crosses the boundary.
 */
export function createWyClient<T extends Record<string, FunctionDef>>(
  config: WyStackClientConfig,
): { client: ReturnType<typeof createClient>; api: ProxyClient<T> } {
  const client = createClient(config)

  const api = new Proxy({} as ProxyClient<T>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      const path = prop

      return {
        useQuery(args?: unknown) {
          return useWyQuery(path, args)
        },
        useMutation() {
          return useWyMutation(path)
        },
      }
    },
  })

  return { client, api }
}
