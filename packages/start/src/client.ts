/**
 * WyStack client for @wystack/start — manages HTTP calls and WS connection.
 * The app provides getToken for auth; WyStack never touches auth internals.
 */

export interface WyStartClientConfig {
  /** WyStack server URL (e.g., 'http://localhost:3001') */
  url: string
  /** App-provided function to get auth token. Called per HTTP request and on WS connect. */
  getToken?: () => Promise<string | null> | string | null
}

export interface WyStartClient {
  url: string
  getToken: () => Promise<string | null> | string | null
  /** HTTP call to a WyStack function */
  call: (path: string, args?: unknown) => Promise<unknown>
  /** WS connection for invalidation signals */
  ws: WebSocket | null
  connect: () => void
  disconnect: () => void
  /** Subscribe to invalidation signals for a function */
  onInvalidate: (subId: string, path: string, args: unknown, callback: () => void) => void
  offInvalidate: (subId: string) => void
}

export function createWyStartClient(config: WyStartClientConfig): WyStartClient {
  const baseUrl = config.url.replace(/\/$/, '')
  const getToken = config.getToken ?? (() => null)
  const invalidateHandlers = new Map<string, () => void>()
  const activeSubs = new Map<string, { path: string; args: unknown }>()

  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  async function getAuthHeaders(): Promise<Record<string, string>> {
    const token = await getToken()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  async function call(path: string, args: unknown = {}) {
    const auth = await getAuthHeaders()
    const res = await fetch(`${baseUrl}/wystack/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(args),
    })
    const json = await res.json()
    if (json.error) throw new Error(json.error)
    return json.data
  }

  function connect() {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

    const wsUrl = baseUrl.replace(/^http/, 'ws') + '/wystack/ws'

    Promise.resolve(getToken()).then(token => {
      const url = token ? `${wsUrl}?token=${encodeURIComponent(token)}` : wsUrl

      try {
        ws = new WebSocket(url)
      } catch {
        scheduleReconnect()
        return
      }

      ws.onopen = () => {
        reconnectAttempt = 0
        // Re-subscribe all active subscriptions
        for (const [subId, sub] of activeSubs) {
          ws!.send(JSON.stringify({ type: 'subscribe', id: subId, path: sub.path, args: sub.args }))
        }
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'invalidate' && msg.id) {
            invalidateHandlers.get(msg.id)?.()
          }
        } catch {
          // Ignore malformed messages
        }
      }

      ws.onclose = () => {
        ws = null
        scheduleReconnect()
      }

      ws.onerror = () => {
        // onclose will fire
      }
    })
  }

  function scheduleReconnect() {
    if (reconnectTimer) return
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 30000)
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
  }

  function onInvalidate(subId: string, path: string, args: unknown, callback: () => void) {
    invalidateHandlers.set(subId, callback)
    activeSubs.set(subId, { path, args })

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', id: subId, path, args }))
    }
  }

  function offInvalidate(subId: string) {
    invalidateHandlers.delete(subId)
    activeSubs.delete(subId)

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unsubscribe', id: subId }))
    }
  }

  return {
    url: baseUrl,
    getToken,
    call,
    get ws() { return ws },
    connect,
    disconnect,
    onInvalidate,
    offInvalidate,
  }
}
