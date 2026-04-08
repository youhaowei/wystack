/**
 * WyStack Client — manages HTTP calls (GET queries, POST mutations)
 * and WS connection for live invalidation.
 *
 * The app provides getToken for HTTP auth. WebSocket auth is optional and can
 * be disabled for trusted transports via `requiresAuth: false`.
 */
import type { WyStackClientConfig } from './types'
import type { QueryRef, MutationRef, RefArgs, RefReturn } from './refs'
import { createWsManager, type WsManager } from './ws'

type FunctionPath = string | { readonly _path: string }

export interface WyStackClient {
  url: string
  prefix: string
  ws: WsManager
  /** Fetch a query result via GET */
  query<TRef extends QueryRef>(ref: TRef, args: RefArgs<TRef>): Promise<RefReturn<TRef>>
  query<T = unknown>(path: string, args?: unknown): Promise<T>
  /** Execute a mutation via POST */
  mutate<TRef extends MutationRef>(ref: TRef, args: RefArgs<TRef>): Promise<RefReturn<TRef>>
  mutate<TArgs = unknown, TReturn = unknown>(path: string, args?: TArgs): Promise<TReturn>
}

export function createClient(config: WyStackClientConfig): WyStackClient {
  const httpUrl = config.url.replace(/\/$/, '')
  const prefix = config.prefix ?? '/api'
  const getToken = config.getToken

  const wsUrl = httpUrl.replace(/^http/, 'ws') + `${prefix}/ws`
  const ws = createWsManager({ url: wsUrl, getToken, requiresAuth: config.requiresAuth })

  async function getAuthHeaders(): Promise<Record<string, string>> {
    const token = await getToken?.()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  function resolvePath(pathOrRef: FunctionPath): string {
    return typeof pathOrRef === 'string' ? pathOrRef : pathOrRef._path
  }

  return {
    url: httpUrl,
    prefix,
    ws,

    async query(pathOrRef: FunctionPath, args?: unknown) {
      const path = resolvePath(pathOrRef)
      const auth = await getAuthHeaders()
      // TODO: fall back to POST for large args that would exceed URL length limits
      const argsParam =
        args !== undefined ? `?args=${encodeURIComponent(JSON.stringify(args))}` : ''
      const res = await fetch(`${httpUrl}${prefix}/${path}${argsParam}`, {
        headers: auth,
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      return json.data
    },

    async mutate(pathOrRef: FunctionPath, args?: unknown) {
      const path = resolvePath(pathOrRef)
      const auth = await getAuthHeaders()
      const res = await fetch(`${httpUrl}${prefix}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(args ?? {}),
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`)
      }
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      return json.data
    },
  }
}
