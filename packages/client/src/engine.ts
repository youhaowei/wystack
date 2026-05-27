import type { Pipe, ClientMessage, ServerMessage } from '@wystack/transport'
import { parseServerMessage } from '@wystack/transport'

type InvalidateHandler = () => void

export interface PipeConnection<In = unknown, Out = unknown> {
  pipe: Pipe<In, Out>
  /**
   * Register a handler invoked when the underlying transport closes.
   * The callback is best-effort: some adapters may not provide a close code.
   */
  onClose(handler: (info: { code?: number; reason?: string }) => void): () => void
}

export interface ClientEngineConfig {
  /**
   * Create a new connection attempt. The returned `pipe` is the raw wire pipe:
   * `string` frames in both directions (JSON text frames for WS-like transports).
   *
   * The engine is responsible for parsing inbound frames (`ServerMessage`) and
   * serializing outbound frames (`ClientMessage`).
   */
  createConnection: () => Promise<PipeConnection<string, string>> | PipeConnection<string, string>

  /**
   * Provide a token for Bearer auth. When auth is required, the engine sends an
   * `auth` frame on connect and waits for `{type:"authenticated"}` before
   * replaying subscriptions.
   */
  getToken?: () => Promise<string | null> | string | null

  /**
   * Send an auth frame on connect. Defaults to `true` when `getToken` is set,
   * `false` otherwise.
   */
  requiresAuth?: boolean

  /** Max ms to wait for `{type:"authenticated"}` after sending `auth`. */
  authAckTimeoutMs?: number

  /** Optional hook for diagnostics/tests when the server acks a subscription. */
  onSubscribed?: (id: string) => void

  /**
   * Reconnect policy knobs. Matches prior `ws.ts` semantics.
   * - `maxReconnectDelayMs`: clamp exponential backoff (default: 30s)
   */
  maxReconnectDelayMs?: number
}

export interface ClientEngine {
  connect(): void
  disconnect(): void
  /**
   * Register (or replace) a subscription. Returns when the server sends
   * `{type:"subscribed", id}` (or rejects on `{type:"error", id}`).
   *
   * The engine keeps the subscription in a registry and will replay it on
   * reconnect after auth completes.
   */
  subscribe(
    id: string,
    path: string,
    args: Record<string, unknown>,
    onInvalidate: InvalidateHandler,
  ): Promise<void>
  /**
   * Remove a subscription (local registry + server request). Best-effort on the
   * wire — the v0.2 protocol has no unsubscribe ack, so this resolves after
   * the local registry is cleared and the frame is sent (if connected).
   */
  unsubscribe(id: string): Promise<void>
  isConnected(): boolean
}

type Pending = { resolve: () => void; reject: (err: Error) => void }

export function createClientEngine(config: ClientEngineConfig): ClientEngine {
  const requiresAuth = config.requiresAuth ?? config.getToken !== undefined
  const authAckTimeoutMs = config.authAckTimeoutMs ?? 10_000
  const maxReconnectDelayMs = config.maxReconnectDelayMs ?? 30_000

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let authAckTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  let connected = false
  let authenticated = false
  let authFailed = false

  let connectGeneration = 0
  let conn: PipeConnection<string, string> | null = null
  let detachOnMessage: (() => void) | null = null
  let detachOnClose: (() => void) | null = null

  const handlers = new Map<string, InvalidateHandler>()
  const activeSubs = new Map<string, { path: string; args: Record<string, unknown> }>()
  const pendingById = new Map<string, Pending>()

  function clearAuthAckTimer() {
    if (!authAckTimer) return
    clearTimeout(authAckTimer)
    authAckTimer = null
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  function scheduleReconnect() {
    if (authFailed) return
    if (reconnectTimer) return
    const base = 1000 * 2 ** Math.min(reconnectAttempt, 5)
    const jitter = base * (0.5 + Math.random() * 0.5)
    const delay = Math.min(jitter, maxReconnectDelayMs)
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function safeRejectPendingFor(id: string, error: Error) {
    const pending = pendingById.get(id)
    if (!pending) return
    pendingById.delete(id)
    pending.reject(error)
  }

  function send(message: ClientMessage) {
    const c = conn
    if (!c) return
    // Outbound pipe is `string` frames. Engine owns JSON serialization.
    void c.pipe.send(JSON.stringify(message))
  }

  function sendSubscriptions() {
    if (!authenticated) return
    for (const [id, sub] of activeSubs) {
      send({ type: 'subscribe', id, path: sub.path, args: sub.args })
    }
  }

  function handleServerMessage(msg: ServerMessage) {
    // Any server message indicates the channel is actually useful.
    reconnectAttempt = 0

    if (msg.type === 'authenticated') {
      if (authenticated) return
      authenticated = true
      clearAuthAckTimer()
      sendSubscriptions()
      return
    }

    if (msg.type === 'invalidate') {
      handlers.get(msg.id)?.()
      return
    }

    if (msg.type === 'subscribed') {
      config.onSubscribed?.(msg.id)
      const pending = pendingById.get(msg.id)
      if (pending) {
        pendingById.delete(msg.id)
        pending.resolve()
      }
      return
    }

    if (msg.type === 'error') {
      const err = new Error(msg.error)
      if (msg.id) safeRejectPendingFor(msg.id, err)
      // Connection-level errors are surfaced only via reconnect/close policy.
      return
    }
  }

  function teardownCurrentConnection() {
    detachOnMessage?.()
    detachOnMessage = null
    detachOnClose?.()
    detachOnClose = null

    const c = conn
    conn = null
    connected = false
    authenticated = false
    clearAuthAckTimer()

    if (c) {
      void c.pipe.close()
    }
  }

  function handleClose(info: { code?: number; reason?: string }) {
    connected = false
    authenticated = false
    clearAuthAckTimer()

    // 4001 — auth failed / protocol violation; latch and do NOT reconnect.
    if (info.code === 4001 || authFailed) {
      authFailed = true
      // Fire all invalidation callbacks so consumers refetch via HTTP.
      for (const handler of handlers.values()) handler()
      // Reject any in-flight calls so callers don't hang.
      for (const [id, pending] of pendingById) {
        pending.reject(new Error(info.reason ?? 'Auth failed'))
        pendingById.delete(id)
      }
      return
    }

    scheduleReconnect()
  }

  function connect() {
    if (authFailed) return
    const generation = ++connectGeneration

    // Cancel any queued reconnect — connect() is authoritative.
    clearReconnectTimer()

    const tokenPromise = requiresAuth
      ? Promise.resolve().then(() => config.getToken?.())
      : Promise.resolve(null)

    tokenPromise
      .then(async (token) => {
        if (generation !== connectGeneration) return
        if (authFailed) return

        teardownCurrentConnection()

        let next: PipeConnection<string, string>
        try {
          next = await config.createConnection()
        } catch {
          scheduleReconnect()
          return
        }

        if (generation !== connectGeneration) {
          void next.pipe.close()
          return
        }

        conn = next
        connected = true
        authenticated = !requiresAuth

        detachOnMessage = next.pipe.onMessage((raw) => {
          // Inbound pipe is `string` frames. Engine owns parsing.
          const parsed = parseServerMessage(raw)
          if (parsed === null) return
          handleServerMessage(parsed)
        })

        detachOnClose = next.onClose((info) => {
          if (generation !== connectGeneration) return
          handleClose(info)
        })

        if (requiresAuth) {
          send({ type: 'auth', token: token ?? null })
          authAckTimer = setTimeout(() => {
            authAckTimer = null
            // Treat as transient close: tear down and reconnect via backoff.
            teardownCurrentConnection()
            scheduleReconnect()
          }, authAckTimeoutMs)
        } else {
          sendSubscriptions()
        }
      })
      .catch(() => {
        if (generation !== connectGeneration) return
        scheduleReconnect()
      })
  }

  function disconnect() {
    connectGeneration++
    clearReconnectTimer()
    teardownCurrentConnection()

    // Reset authFailed so a later connect() (e.g. after re-login) can try again.
    authFailed = false

    // Reject any pending subscribe calls; caller can retry after reconnect.
    for (const [id, pending] of pendingById) {
      pending.reject(new Error('Disconnected'))
      pendingById.delete(id)
    }
  }

  async function subscribe(
    id: string,
    path: string,
    args: Record<string, unknown>,
    onInvalidate: InvalidateHandler,
  ): Promise<void> {
    handlers.set(id, onInvalidate)
    activeSubs.set(id, { path, args })

    const prior = pendingById.get(id)
    if (prior) {
      prior.reject(new Error('Replaced'))
      pendingById.delete(id)
    }

    const pending = new Promise<void>((resolve, reject) => {
      pendingById.set(id, { resolve, reject })
    })

    if (authenticated) {
      send({ type: 'subscribe', id, path, args })
    }
    // Otherwise: replayed on (re)connect via sendSubscriptions()

    return pending
  }

  async function unsubscribe(id: string): Promise<void> {
    handlers.delete(id)
    activeSubs.delete(id)

    // If there was an in-flight subscribe for this id, reject it.
    safeRejectPendingFor(id, new Error('Unsubscribed'))

    if (authenticated) {
      send({ type: 'unsubscribe', id })
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
