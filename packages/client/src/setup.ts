/**
 * createWyStack — one-line setup for @wystack/client.
 *
 * Returns { Provider, api, client } — everything needed to use WyStack in React.
 * The Provider is pre-bound to the client it creates internally.
 */
import type { WyStackClientConfig } from './types.js'
import type { ApiFromFunctions, FunctionDefinition } from './refs.js'
import type { WebClient, WyStackClient } from './client.js'
import { createClient } from './client.js'
import { createReactBindings, type CreateReactBindingsOptions } from './bindings.js'

export interface WyStackInstance<T extends Record<string, FunctionDefinition>> {
  /** Pre-bound Provider — wraps children in both QueryClientProvider and WyStackProvider. */
  Provider: React.FC<{ children: React.ReactNode }>
  /** Typed api object — each key is a phantom-branded QueryRef or MutationRef. */
  api: ApiFromFunctions<T>
  /** Raw client for imperative use (scripts, tests, server components). */
  client: WyStackClient
}

export type CreateWyStackOptions = CreateReactBindingsOptions

/**
 * One-line setup. Call at module scope — never inside a component, or every
 * render will mint a new client and wipe the cache.
 *
 * ```ts
 * const { Provider, api, client } = createWyStack<typeof functions>({ url })
 * ```
 */
export function createWyStack<T extends Record<string, FunctionDefinition>>(
  config: WyStackClientConfig,
  options: CreateWyStackOptions = {},
): WyStackInstance<T> {
  const client = createClient(config)
  return createReactBindings<T, WebClient>(client, options)
}
