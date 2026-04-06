/**
 * WyStack Client — manages HTTP calls (GET queries, POST mutations)
 * and WS connection for live invalidation.
 *
 * The app provides getToken for auth; WyStack never touches auth internals.
 */
import type { WyStackClientConfig } from './types'
import { createWsManager, type WsManager } from './ws'

export interface WyStackClient {
  url: string
  prefix: string
  ws: WsManager
  /** Fetch a query result via GET */
  query: (path: string, args?: unknown) => Promise<unknown>
  /** Execute a mutation via POST */
  mutate: (path: string, args?: unknown) => Promise<unknown>
}

export function createClient(config: WyStackClientConfig): WyStackClient {
  const httpUrl = config.url.replace(/\/$/, '')
  const prefix = config.prefix ?? '/api'
  const getToken = config.getToken

  const wsUrl = httpUrl.replace(/^http/, 'ws') + `${prefix}/ws`
  const ws = createWsManager({ url: wsUrl, getToken })

  async function getAuthHeaders(): Promise<Record<string, string>> {
    const token = await getToken?.()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  return {
    url: httpUrl,
    prefix,
    ws,

    async query(path: string, args?: unknown) {
      const auth = await getAuthHeaders()
      const argsParam =
        args !== undefined ? `?args=${encodeURIComponent(JSON.stringify(args))}` : ''
      const res = await fetch(`${httpUrl}${prefix}/${path}${argsParam}`, {
        headers: auth,
      })
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      return json.data
    },

    async mutate(path: string, args?: unknown) {
      const auth = await getAuthHeaders()
      const res = await fetch(`${httpUrl}${prefix}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(args ?? {}),
      })
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      return json.data
    },
  }
}
