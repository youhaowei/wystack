/**
 * WebSocket Manager — manages connection lifecycle, exponential backoff
 * reconnection, subscription tracking, and invalidation dispatch.
 *
 * Protocol (matches @wystack/server):
 *   Client → Server: { type: 'auth', v, token }           (first frame when auth is configured)
 *   Client → Server: { type: 'subscribe', id, path, args }
 *   Client → Server: { type: 'unsubscribe', id }
 *   Server → Client: { type: 'authenticated' }            (ack for successful auth)
 *   Server → Client: { type: 'subscribed', id }
 *   Server → Client: { type: 'invalidate', id }
 *   Server → Client: { type: 'error', id?, error }
 *
 * Close codes:
 *   4001 — auth failed / missing / protocol violation → do NOT reconnect
 *   4002 — auth timeout → reconnect per normal backoff
 */

/**
 * WS wire-protocol version. Distinct from `@wystack/client` package version:
 * bumped only on wire-format changes.
 *
 * SYNC: keep in lockstep with `WS_PROTOCOL_VERSION` in `@wystack/server`
 * (`packages/server/src/routes.ts`).
 */
const WS_PROTOCOL_VERSION = '0.1.0'

type InvalidateHandler = () => void

export interface WsManagerConfig {
  url: string
  getToken?: () => Promise<string | null> | string | null
  /**
   * Max ms to wait for the server's `{type:"authenticated"}` ack after sending
   * the auth frame. Only applies when `getToken` is configured. Default: 10_000.
   */
  authAckTimeoutMs?: number
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
  const requiresAuth = getToken !== undefined
  // Fail fast if the server never sends `{type:"authenticated"}`. Catches
  // config mismatches (server without resolveContext) and server bugs.
  const authAckTimeoutMs = config.authAckTimeoutMs ?? 10_000
  let ws: WebSocket | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let authAckTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  const maxReconnectDelay = 30000
  const handlers = new Map<string, InvalidateHandler>()
  const activeSubs = new Map<string, { path: string; args: unknown }>()
  let connected = false
  let authenticated = false
  let authFailed = false

  function scheduleReconnect() {
    if (authFailed) return
    if (reconnectTimer) return
    const base = 1000 * 2 ** Math.min(reconnectAttempt, 5)
    const jitter = base * (0.5 + Math.random() * 0.5)
    const delay = Math.min(jitter, maxReconnectDelay)
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function sendSubscriptions() {
    if (!ws || ws.readyState !== WebSocket.OPEN || !authenticated) return
    for (const [id, sub] of activeSubs) {
      ws.send(JSON.stringify({ type: 'subscribe', id, path: sub.path, args: sub.args }))
    }
  }

  function connect() {
    if (authFailed) return
    if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

    Promise.resolve(getToken?.())
      .then((token) => {
        if (authFailed) return
        if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

        try {
          ws = new WebSocket(url)
        } catch {
          scheduleReconnect()
          return
        }

        authenticated = !requiresAuth

        ws.onopen = () => {
          connected = true
          // Do not reset reconnectAttempt here — wait until the server sends
          // a message. Prevents tight reconnect loops when the server opens
          // then closes without any response (e.g., auth-required server +
          // no-token client → 4002 timeout loop).
          if (requiresAuth) {
            ws!.send(JSON.stringify({ type: 'auth', v: WS_PROTOCOL_VERSION, token }))
            // Wait for {type:"authenticated"} ack before replaying subscriptions.
            // If no ack arrives, close 4002 (transient/retry) so normal backoff
            // applies. Real auth rejections arrive as an explicit server-side
            // 4001 and latch authFailed in onclose — not here.
            authAckTimer = setTimeout(() => {
              authAckTimer = null
              ws?.close(4002, 'auth ack timeout')
            }, authAckTimeoutMs)
          } else {
            sendSubscriptions()
          }
        }

        ws.onmessage = (event) => {
          // Any server message proves the connection is actually useful.
          reconnectAttempt = 0
          try {
            const msg = JSON.parse(event.data)
            if (msg.type === 'authenticated') {
              authenticated = true
              if (authAckTimer) {
                clearTimeout(authAckTimer)
                authAckTimer = null
              }
              sendSubscriptions()
              return
            }
            if (msg.type === 'invalidate' && msg.id) {
              handlers.get(msg.id)?.()
            }
          } catch (err) {
            if (process.env.NODE_ENV !== 'production') {
              console.warn('[wystack/ws] Failed to parse message:', err)
            }
          }
        }

        ws.onclose = (event) => {
          connected = false
          authenticated = false
          if (authAckTimer) {
            clearTimeout(authAckTimer)
            authAckTimer = null
          }
          if (event.code === 4001 || authFailed) {
            authFailed = true
            // Fire all invalidation callbacks so consumers refetch via HTTP.
            // If HTTP auth also fails on the same token, TanStack Query
            // surfaces the error. If HTTP succeeds, data is fresh but
            // real-time updates stay off until disconnect() + reconnect()
            // with a new token.
            // Per-handler try/catch: one throwing consumer must not drop
            // remaining invalidations.
            for (const handler of handlers.values()) {
              try {
                handler()
              } catch (err) {
                if (process.env.NODE_ENV !== 'production') {
                  console.warn('[wystack/ws] invalidation handler threw on 4001:', err)
                }
              }
            }
            return
          }
          scheduleReconnect()
        }

        ws.onerror = () => {
          // onclose will fire after this
        }
      })
      .catch(() => {
        scheduleReconnect()
      })
  }

  function disconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (authAckTimer) {
      clearTimeout(authAckTimer)
      authAckTimer = null
    }
    connected = false
    authenticated = false
    // Reset authFailed so a later connect() (e.g., after re-login) can try again.
    authFailed = false
    if (ws) {
      ws.onclose = null
      ws.close()
      ws = null
    }
  }

  function subscribe(id: string, path: string, args: unknown, onInvalidate: InvalidateHandler) {
    handlers.set(id, onInvalidate)
    activeSubs.set(id, { path, args })
    if (ws?.readyState === WebSocket.OPEN && authenticated) {
      ws.send(JSON.stringify({ type: 'subscribe', id, path, args }))
    }
    // Otherwise: replayed on (re)connect via sendSubscriptions()
  }

  function unsubscribe(id: string) {
    handlers.delete(id)
    activeSubs.delete(id)
    if (ws?.readyState === WebSocket.OPEN && authenticated) {
      ws.send(JSON.stringify({ type: 'unsubscribe', id }))
    }
    // If not sent to server yet, removing from activeSubs is enough.
  }

  return {
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    isConnected: () => connected,
  }
}
