/**
 * createWyStack — one-line setup for @wystack/client.
 *
 * Returns { Provider, api, client } — everything needed to use WyStack in React.
 * The Provider is pre-bound to the client it creates internally.
 */
import type { FunctionDef } from '@wystack/server'
import type { WyStackClientConfig } from './types'
import type { ApiFromFunctions } from './refs'
import type { WebClient, WyStackClient } from './client'
import { createClient } from './client'
import { createReactBindings, type CreateReactBindingsOptions } from './bindings'

export interface WyStackInstance<T extends Record<string, FunctionDef>> {
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
export function createWyStack<T extends Record<string, FunctionDef>>(
  config: WyStackClientConfig,
  options: CreateWyStackOptions = {},
): WyStackInstance<T> {
  const client = createClient(config)
  return createReactBindings<T, WebClient>(client, options)
}
