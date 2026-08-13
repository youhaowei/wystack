import { createElement } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createApi } from './api'
import type { Client } from './core-client'
import type { ApiFromFunctions, FunctionDefinition } from './refs'
import { WyStackProvider } from './react-provider'

export interface WyStackReactBindings<
  TFunctions extends Record<string, FunctionDefinition>,
  TClient extends Client = Client,
> {
  Provider: React.FC<{ children: React.ReactNode }>
  api: ApiFromFunctions<TFunctions>
  client: TClient
}

export interface CreateReactBindingsOptions {
  /** Share an existing TanStack QueryClient instead of creating one. */
  queryClient?: QueryClient
}

/** Compose typed React bindings around an already-created platform client. */
export function createReactBindings<
  TFunctions extends Record<string, FunctionDefinition>,
  TClient extends Client = Client,
>(
  client: TClient,
  options: CreateReactBindingsOptions = {},
): WyStackReactBindings<TFunctions, TClient> {
  const api = createApi<TFunctions>()
  const queryClient = options.queryClient ?? new QueryClient()

  function Provider({ children }: { children: React.ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(WyStackProvider, { client, children }),
    )
  }

  return { Provider, api, client }
}
