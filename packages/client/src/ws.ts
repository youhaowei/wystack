/**
 * WebSocket Manager — manages connection lifecycle, exponential backoff
 * reconnection, subscription tracking, and invalidation dispatch.
 *
 * Protocol (matches @wystack/server):
 *   Client → Server: { type: 'auth', token }              (first frame when requiresAuth is true; token may be null for cookie/proxy auth)
 *   Client → Server: { type: 'subscribe', id, path, args }
 *   Client → Server: { type: 'unsubscribe', id }
 *   Server → Client: { type: 'authenticated' }            (ack when WS auth is enabled)
 *   Server → Client: { type: 'subscribed', id }
 *   Server → Client: { type: 'invalidate', id }
 *   Server → Client: { type: 'error', id?, error }
 *
 * Close codes:
 *   4001 — auth failed / missing / protocol violation → latch authFailed, do NOT reconnect
 *   4002 — transient (auth-frame timeout, ack-send transport flake, ack-receive timeout)
 *          → reconnect per normal exponential backoff
 */

type InvalidateHandler = () => void

export interface WsManagerConfig {
  url: string
  /**
   * Provide a token for Bearer auth. When set, the client sends an auth frame
   * on connect and waits for the server's `{type:"authenticated"}` ack before
   * replaying subscriptions. Return `null` for anonymous auth (e.g., cookie /
   * session-based) — the auth frame is still sent with no token, triggering
   * `resolveContext` on the server with the original upgrade request headers.
   *
   * Set `requiresAuth: false` to force a trusted/no-auth WS connection even
   * when `getToken` exists for HTTP. This is the intended mode for transports
   * with in-process trust, such as IPC-backed local runtimes.
   */
  getToken?: () => Promise<string | null> | string | null
  /**
   * Send an auth frame on connect even when `getToken` is not provided.
   * Use this for servers that have `resolveContext` configured but authenticate
   * via cookies or proxy headers rather than a client-supplied token — the auth
   * frame carries no token but still triggers `resolveContext` on the server.
   *
   * Defaults to `true` when `getToken` is set, `false` otherwise.
   */
  requiresAuth?: boolean
  /**
   * Max ms to wait for the server's `{type:"authenticated"}` ack after sending
   * the auth frame. Only applies when auth is required. Default: 10_000.
   */
  authAckTimeoutMs?: number
  /** Test/diagnostic hook for the server's subscription acknowledgement. */
  onSubscribed?: (id: string) => void
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
  const requiresAuth = config.requiresAuth ?? getToken !== undefined
  // Fail fast only when WS auth is enabled and the server never sends
  // `{type:"authenticated"}`. No-auth transports start usable immediately.
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
  // `connect()` awaits `getToken()` before constructing the WebSocket. A
  // monotonic generation counter lets each attempt self-identify: disconnect()
  // and subsequent connect() calls both increment the counter, so a stale
  // `.then` or `.catch` can detect it's no longer the active attempt and bail
  // without racing on a shared boolean.
  let connectGeneration = 0

  function clearAuthAckTimer() {
    if (authAckTimer) {
      clearTimeout(authAckTimer)
      authAckTimer = null
    }
  }

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
    const generation = ++connectGeneration

    // Only invoke getToken when auth is actually required. If requiresAuth is
    // false (explicit override or no getToken), skip the token fetch entirely
    // so a slow or throwing getToken can't block or crash a no-auth connection.
    const tokenPromise = requiresAuth ? Promise.resolve(getToken?.()) : Promise.resolve(null)
    tokenPromise
      .then((token) => {
        if (generation !== connectGeneration) return
        if (authFailed) return
        if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return

        try {
          ws = new WebSocket(url)
        } catch {
          scheduleReconnect()
          return
        }

        // Capture a local reference so stale callbacks (authAckTimer, onclose,
        // onmessage, onerror) cannot accidentally act on a socket created by a
        // later connect() call.
        const socket = ws
        authenticated = !requiresAuth

        socket.onopen = () => {
          connected = true
          // Do not reset reconnectAttempt here — wait until the server sends
          // a message. Prevents tight reconnect loops when the server opens
          // then closes without any response (e.g., auth-required server +
          // no-token client → 4002 timeout loop).
          if (requiresAuth) {
            socket.send(JSON.stringify({ type: 'auth', token }))
            // Wait for {type:"authenticated"} ack before replaying subscriptions.
            // If no ack arrives, close 4002 (transient/retry) so normal backoff
            // applies. Real auth rejections arrive as an explicit server-side
            // 4001 and latch authFailed in onclose — not here.
            authAckTimer = setTimeout(() => {
              authAckTimer = null
              socket.close(4002, 'auth ack timeout')
            }, authAckTimeoutMs)
          } else {
            sendSubscriptions()
          }
        }

        socket.onmessage = (event) => {
          // Any server message proves the connection is actually useful.
          reconnectAttempt = 0
          try {
            const msg = JSON.parse(event.data)
            if (msg.type === 'authenticated') {
              // Idempotent guard: if a duplicate ACK arrives (e.g., from a
              // concurrent server-side auth race), don't replay subscriptions.
              if (authenticated) return
              authenticated = true
              clearAuthAckTimer()
              sendSubscriptions()
              return
            }
            if (msg.type === 'invalidate' && msg.id) {
              handlers.get(msg.id)?.()
            }
            if (msg.type === 'subscribed' && msg.id) {
              config.onSubscribed?.(msg.id)
            }
          } catch (err) {
            if (process.env.NODE_ENV !== 'production') {
              console.warn('[wystack/ws] Failed to parse message:', err)
            }
          }
        }

        socket.onclose = (event) => {
          connected = false
          authenticated = false
          clearAuthAckTimer()
          if (event.code === 4001 || authFailed) {
            authFailed = true
            // Fire all invalidation callbacks so consumers refetch via HTTP.
            // If HTTP auth also fails on the same token, TanStack Query
            // surfaces the error. If HTTP succeeds, data is fresh but
            // real-time updates stay off until disconnect() + reconnect()
            // with a new token.
            for (const handler of handlers.values()) handler()
            return
          }
          scheduleReconnect()
        }

        socket.onerror = () => {
          // onclose will fire after this
        }
      })
      .catch(() => {
        if (generation !== connectGeneration) return
        scheduleReconnect()
      })
  }

  function disconnect() {
    connectGeneration++
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    clearAuthAckTimer()
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
