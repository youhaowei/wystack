/**
 * createWyStack — one-line setup for @wystack/client.
 *
 * Returns { Provider, api, client } — everything needed to use WyStack in React.
 * The Provider is pre-bound to the client it creates internally.
 */
import { createElement } from 'react'
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

export interface CreateWyStackOptions {
  /**
   * Optional TanStack QueryClient to share with the rest of the app. If
   * omitted, a fresh QueryClient with default config is created.
   */
  queryClient?: QueryClient
}

/**
 * One-line setup. Call at module scope — never inside a component, or every
 * render will mint a new client and wipe the cache.
 *
 * ```ts
 * const { Provider, api, client } = createWyStack<typeof functions>({ url })
 * ```
 */
export function createWyStack<T extends Record<string, FunctionDef>>(
  config: WyStackClientConfig,
  options: CreateWyStackOptions = {},
): WyStackInstance<T> {
  const client = createClient(config)
  const api = createApi<T>()
  const queryClient = options.queryClient ?? new QueryClient()

  function Provider({ children }: { children: React.ReactNode }) {
    // WS lifecycle is owned by InternalProvider's useEffect; do not duplicate it here.
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(InternalProvider, { client, children }),
    )
  }

  return { Provider, api, client }
}
