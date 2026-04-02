/**
 * WebSocket Manager — manages connection lifecycle, exponential backoff
 * reconnection, and dispatches messages to subscription handlers.
 */

type MessageHandler = (data: unknown) => void

export interface WsManager {
  connect(): void
  disconnect(): void
  subscribe(id: string, path: string, args: unknown, handler: MessageHandler): void
  unsubscribe(id: string): void
  isConnected(): boolean
}

export function createWsManager(url: string): WsManager {
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  const maxReconnectDelay = 30000
  const handlers = new Map<string, MessageHandler>()
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

  function connect() {
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

    try {
      ws = new WebSocket(url)
    } catch {
      scheduleReconnect()
      return
    }

    ws.onopen = () => {
      connected = true
      reconnectAttempt = 0
      // Re-subscribe all active subscriptions on reconnect
      for (const [id, sub] of activeSubs) {
        ws!.send(JSON.stringify({ type: 'subscribe', id, path: sub.path, args: sub.args }))
      }
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.id && handlers.has(msg.id)) {
          handlers.get(msg.id)!(msg)
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

  function subscribe(id: string, path: string, args: unknown, handler: MessageHandler) {
    handlers.set(id, handler)
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
