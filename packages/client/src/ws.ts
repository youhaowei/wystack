/**
 * WebSocket Manager — manages connection lifecycle, exponential backoff
 * reconnection, subscription tracking, and invalidation dispatch.
 *
 * Protocol (matches @wystack/server):
 *   Client → Server: { type: 'subscribe', id, path, args }
 *   Client → Server: { type: 'unsubscribe', id }
 *   Server → Client: { type: 'subscribed', id }
 *   Server → Client: { type: 'invalidate', id }
 *   Server → Client: { type: 'error', id?, error }
 */

type InvalidateHandler = () => void

export interface WsManagerConfig {
  url: string
  getToken?: () => Promise<string | null> | string | null
}

export interface WsManager {
  connect(): void
  disconnect(): void
  subscribe(id: string, path: string, args: unknown, onInvalidate: InvalidateHandler): void
  unsubscribe(id: string): void
  isConnected(): boolean
}

export function createWsManager(config: WsManagerConfig): WsManager {
  const { url, getToken } = config
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  const maxReconnectDelay = 30000
  const handlers = new Map<string, InvalidateHandler>()
  const activeSubs = new Map<string, { path: string; args: unknown }>()
  let connected = false

  function scheduleReconnect() {
    if (reconnectTimer) return
    const delay = Math.min(1000 * 2 ** reconnectAttempt, maxReconnectDelay)
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function sendSubscriptions() {
    for (const [id, sub] of activeSubs) {
      ws!.send(JSON.stringify({ type: 'subscribe', id, path: sub.path, args: sub.args }))
    }
  }

  function connect() {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

    Promise.resolve(getToken?.()).then(token => {
      // Re-check after async — another connect() may have fired
      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

      const wsUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url

      try {
        ws = new WebSocket(wsUrl)
      } catch {
        scheduleReconnect()
        return
      }

      ws.onopen = () => {
        connected = true
        reconnectAttempt = 0
        sendSubscriptions()
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.type === 'invalidate' && msg.id) {
            handlers.get(msg.id)?.()
          }
        } catch {
          // Ignore malformed messages
        }
      }

      ws.onclose = () => {
        connected = false
        scheduleReconnect()
      }

      ws.onerror = () => {
        // onclose will fire after this
      }
    })
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    connected = false
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
  }

  function subscribe(id: string, path: string, args: unknown, onInvalidate: InvalidateHandler) {
    handlers.set(id, onInvalidate)
    activeSubs.set(id, { path, args })

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', id, path, args }))
    }
  }

  function unsubscribe(id: string) {
    handlers.delete(id)
    activeSubs.delete(id)

    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'unsubscribe', id }))
    }
  }

  return {
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    isConnected: () => connected,
  }
}
