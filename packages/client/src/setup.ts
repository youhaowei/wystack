/**
 * createWyStack — one-line setup for @wystack/client.
 *
 * Returns { Provider, api, client } — everything needed to use WyStack in React.
 * The Provider is pre-bound to the client it creates internally.
 */
import { createElement, useEffect } from 'react'
import { QueryClientProvider, QueryClient } from '@tanstack/react-query'
import type { FunctionDef } from '@wystack/server'
import type { WyStackClientConfig } from './types'
import type { ApiFromFunctions } from './refs'
import type { WyStackClient } from './client'
import { createClient } from './client'
import { createApi } from './api'
import { WyStackProvider as InternalProvider } from './provider'

export interface WyStackInstance<T extends Record<string, FunctionDef>> {
  /** Pre-bound Provider — wraps children in both QueryClientProvider and WyStackProvider. */
  Provider: React.FC<{ children: React.ReactNode }>
  /** Typed api object — each key is a phantom-branded QueryRef or MutationRef. */
  api: ApiFromFunctions<T>
  /** Raw client for imperative use (scripts, tests, server components). */
  client: WyStackClient
}

/**
 * One-line setup:
 * ```ts
 * const { Provider, api, client } = createWyStack<typeof functions>({ url })
 * ```
 */
export function createWyStack<T extends Record<string, FunctionDef>>(
  config: WyStackClientConfig,
): WyStackInstance<T> {
  const client = createClient(config)
  const api = createApi<T>()
  const queryClient = new QueryClient()

  function Provider({ children }: { children: React.ReactNode }) {
    useEffect(() => {
      client.ws.connect()
      return () => client.ws.disconnect()
    }, [])

    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(InternalProvider, { client, children }),
    )
  }

  return { Provider, api, client }
}
