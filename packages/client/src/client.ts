/**
 * Proxy Client — createClient<App>({ url }) produces a typed proxy
 * where client.listTodos.useQuery() and client.addTodo.useMutation() work.
 */
import type { WyStackClientConfig } from './types'
import { createWsManager, type WsManager } from './ws'

export interface WyStackClient {
  url: string
  wsUrl: string
  ws: WsManager
  /** HTTP call to a function */
  call: (path: string, args?: unknown) => Promise<unknown>
}

export function createClient(config: WyStackClientConfig): WyStackClient {
  const httpUrl = config.url.replace(/\/$/, '')
  const wsUrl = httpUrl.replace(/^http/, 'ws') + '/ws'
  const ws = createWsManager(wsUrl)
  ws.connect()

  return {
    url: httpUrl,
    wsUrl,
    ws,
    async call(path: string, args: unknown = {}) {
      const res = await fetch(`${httpUrl}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      })
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      return json.data
    },
  }
}
