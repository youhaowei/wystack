// @wystack/client — neutral reactive engine
//
// Owns the carrier-agnostic half of the v0.2 client (Spec ADR #11):
//   - Connection lifecycle (connect / disconnect, exponential-backoff reconnect)
//   - Auth handshake (send `auth`, await `authenticated`)
//   - Subscription registry (replay on (re)connect, invalidation dispatch)
//
// Driven by a `Pipe<ServerMessage, ClientMessage>` factory — never imports a
// concrete transport. The WebSocket-backed factory lives in `ws.ts` (until the
// T3b adapter relocates it). Call/result correlation is intentionally out of
// scope: the transport package does not ship `call` / `result` wire kinds yet
// (Spec ADR #9 — they ride above the engine via `@tanstack/*` for v0.2; a
// neutral correlator lands when the wire does).
//
// Reconnect semantics mirror the previous `ws.ts`:
//   - close-code 4001 → latch `authFailed`, fire invalidations to nudge HTTP
//     refetch, stop retrying.
//   - any other close → exponential backoff (1s base, ×2 per attempt, capped
//     at 30s, [50%, 100%) of base jitter).
//   - `connectGeneration` invalidates stale async callbacks (token fetch,
//     pipe open) when a newer `connect()` or `disconnect()` has happened.

import type { Pipe, ServerMessage, ClientMessage } from '@wystack/transport'

type InvalidateHandler = () => void

/**
 * Engine view of a pipe close. Adapters relay native close codes here so the
 * 4001-latch / 4002-retry policy works the same regardless of carrier.
 */
export interface CloseInfo {
  code: number
}

/**
 * `Pipe<ServerMessage, ClientMessage>` plus a close-event subscription. The
 * base `Pipe` in `@wystack/transport` is lifecycle-agnostic; the engine needs
 * the event to react to 4001/4002 close codes and to schedule reconnects.
 *
 * Adapters return this expanded shape from `createPipe`. The loopback used by
 * engine tests stubs `onClose` with a no-op when close-driven reconnect is
 * not under test.
 */
export type EnginePipe = Pipe<ServerMessage, ClientMessage> & {
  /** Resolves when the underlying carrier can accept frames. */
  ready?: Promise<void>
  onClose(handler: (info: CloseInfo) => void): () => void
}

/**
 * Per-attempt transport factory. Called on connect and again for every
 * reconnect — the engine never reuses a closed pipe. May be async to thread
 * an adapter-side handshake (TLS upgrade, IPC port grant).
 */
export type PipeFactory = () => EnginePipe | Promise<EnginePipe>

export interface EngineConfig {
  createPipe: PipeFactory
  /**
   * Provide a token for the auth handshake. When set, the engine sends an
   * `auth` frame on each (re)connect and waits for `{type:"authenticated"}`
   * before flushing subscriptions. Return `null` for anonymous auth (cookie /
   * proxy headers) — the auth frame is still sent with `token: null`, which
   * triggers `resolveContext` on the server against the upgrade-request
   * headers.
   */
  getToken?: () => Promise<string | null> | string | null
  /**
   * Force the auth handshake on or off, overriding the `getToken`-based
   * default. Use `true` for cookie/proxy auth without a bearer token; use
   * `false` for trusted transports (IPC, local-loopback) where the server is
   * configured without `resolveContext`.
   *
   * Defaults to `true` when `getToken` is set, `false` otherwise.
   */
  requiresAuth?: boolean
  /**
   * Max ms to wait for the server's `{type:"authenticated"}` ack after the
   * auth frame is sent. Only applies when auth is required. Default: 10_000.
   */
  authAckTimeoutMs?: number
  /** Test/diagnostic hook for the server's subscription acknowledgement. */
  onSubscribed?: (id: string) => void
}

export interface Engine {
  connect(): void
  disconnect(): void
  subscribe(
    id: string,
    path: string,
    args: Record<string, unknown>,
    onInvalidate: InvalidateHandler,
  ): void
  unsubscribe(id: string): void
  isConnected(): boolean
}

const MAX_RECONNECT_DELAY_MS = 30_000
const DEFAULT_AUTH_ACK_TIMEOUT_MS = 10_000

export function createEngine(config: EngineConfig): Engine {
  const { createPipe, getToken, onSubscribed } = config
  const requiresAuth = config.requiresAuth ?? getToken !== undefined
  const authAckTimeoutMs = config.authAckTimeoutMs ?? DEFAULT_AUTH_ACK_TIMEOUT_MS

  let pipe: EnginePipe | null = null
  let pipeMessageUnsub: (() => void) | null = null
  let pipeCloseUnsub: (() => void) | null = null

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let authAckTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0

  const handlers = new Map<string, InvalidateHandler>()
  const activeSubs = new Map<string, { path: string; args: Record<string, unknown> }>()

  let connected = false
  let connecting = false
  let authenticated = false
  let authFailed = false

  // Monotonic counter — disconnect() and every connect() increment it so a
  // stale async tail (token fetch, pipe open) can detect it's no longer the
  // active attempt and bail without racing on shared booleans.
  let connectGeneration = 0

  function clearAuthAckTimer() {
    if (authAckTimer !== null) {
      clearTimeout(authAckTimer)
      authAckTimer = null
    }
  }

  function detachPipe() {
    if (pipeMessageUnsub !== null) {
      pipeMessageUnsub()
      pipeMessageUnsub = null
    }
    if (pipeCloseUnsub !== null) {
      pipeCloseUnsub()
      pipeCloseUnsub = null
    }
  }

  function scheduleReconnect() {
    if (authFailed) return
    if (reconnectTimer !== null) return
    const base = 1000 * 2 ** Math.min(reconnectAttempt, 5)
    const jitter = base * (0.5 + Math.random() * 0.5)
    const delay = Math.min(jitter, MAX_RECONNECT_DELAY_MS)
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function sendSubscriptions() {
    if (pipe === null || !authenticated) return
    for (const [id, sub] of activeSubs) {
      safeSend({ type: 'subscribe', id, path: sub.path, args: sub.args }, connectGeneration)
    }
  }

  function safeSend(message: ClientMessage, generation: number) {
    const target = pipe
    if (target === null) return
    void Promise.resolve(target.send(message)).catch(() => {
      handleClose({ code: 1006 }, generation)
    })
  }

  function handleMessage(msg: ServerMessage) {
    // Any inbound message proves the connection is useful — prevents a tight
    // reconnect loop when the server opens then closes without responding
    // (e.g., auth-required server + no-token client → 4002 → retry storm).
    reconnectAttempt = 0

    switch (msg.type) {
      case 'authenticated': {
        // Idempotent guard: a duplicate ACK (e.g., concurrent server-side
        // race) should not replay subscriptions.
        if (authenticated) return
        authenticated = true
        clearAuthAckTimer()
        sendSubscriptions()
        return
      }
      case 'subscribed': {
        onSubscribed?.(msg.id)
        return
      }
      case 'invalidate': {
        handlers.get(msg.id)?.()
        return
      }
      case 'error': {
        // Per-sub errors surface on the next subscribe attempt; connection-
        // level errors arrive paired with a close and are handled there.
        return
      }
    }
  }

  function handleClose(info: CloseInfo, ownGeneration: number) {
    // A close that fires after we've moved on (newer connect / explicit
    // disconnect) must not reset state or schedule a retry — that's the
    // newer attempt's job.
    if (ownGeneration !== connectGeneration) return

    detachPipe()
    pipe = null
    connected = false
    authenticated = false
    clearAuthAckTimer()

    if (info.code === 4001) {
      authFailed = true
      // Fire invalidations so HTTP refetches surface the auth error to the
      // app's data layer. If HTTP also fails, the data layer raises; if it
      // succeeds, data is fresh but the realtime channel stays off until
      // disconnect() + connect() with a new token.
      for (const handler of handlers.values()) handler()
      return
    }
    scheduleReconnect()
  }

  function failAuthAck(ownGeneration: number) {
    // Synthesize a 4002 close locally — the adapter may not surface one for
    // an engine-driven close. Same semantic as the prior ws.ts: ack timeout
    // → transient retry.
    if (ownGeneration !== connectGeneration) return
    const target = pipe
    if (target === null) return
    detachPipe()
    pipe = null
    // close() is idempotent per the @wystack/transport Pipe contract.
    target.close()
    handleClose({ code: 4002 }, ownGeneration)
  }

  function connect() {
    if (authFailed) return
    if (pipe !== null || connecting) return
    connecting = true
    const generation = ++connectGeneration

    // Sequence: resolve the token first, then open the pipe. This ordering
    // guarantees that if `getToken` throws or rejects, no pipe has been
    // created yet — there is nothing to leak. Reversing the order
    // (Promise.all over both concurrently) creates a resource-leak window:
    // if `createPipe` resolves with a live socket and `getToken` then
    // rejects, Promise.all rejects with no reference to the already-open
    // pipe, abandoning it with no close() call.
    const run = async (): Promise<void> => {
      const token: string | null = requiresAuth ? ((await getToken?.()) ?? null) : null

      if (generation !== connectGeneration || authFailed) return

      const opened = await createPipe()

      if (generation !== connectGeneration || authFailed) {
        opened.ready?.catch(() => {})
        opened.close()
        return
      }

      pipe = opened
      pipeMessageUnsub = opened.onMessage(handleMessage)
      pipeCloseUnsub = opened.onClose((info) => handleClose(info, generation))

      try {
        await opened.ready
      } catch {
        if (generation === connectGeneration && pipe === opened) {
          handleClose({ code: 1006 }, generation)
        }
        return
      }

      if (generation !== connectGeneration || authFailed || pipe !== opened) {
        opened.close()
        return
      }

      connected = true
      // Don't reset reconnectAttempt here — wait until a message arrives
      // (handleMessage). Prevents a "server opens then closes immediately"
      // pattern from collapsing the backoff.
      authenticated = !requiresAuth

      if (requiresAuth) {
        // `token: null` (not undefined) — the wire frame must always carry
        // the field. The server's anonymous-path (`resolveContext` against
        // upgrade headers) needs an explicit null sentinel.
        safeSend({ type: 'auth', token: token ?? null }, generation)
        authAckTimer = setTimeout(() => {
          authAckTimer = null
          failAuthAck(generation)
        }, authAckTimeoutMs)
      } else {
        sendSubscriptions()
      }
    }

    run()
      .catch(() => {
        if (generation !== connectGeneration) return
        scheduleReconnect()
      })
      .finally(() => {
        if (generation === connectGeneration) connecting = false
      })
  }

  function disconnect() {
    connectGeneration++
    connecting = false
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    clearAuthAckTimer()
    connected = false
    authenticated = false
    // Reset so a later connect() (e.g., after re-login) can try again.
    authFailed = false
    const target = pipe
    pipe = null
    if (target !== null) {
      detachPipe()
      target.close()
    }
  }

  function subscribe(
    id: string,
    path: string,
    args: Record<string, unknown>,
    onInvalidate: InvalidateHandler,
  ) {
    handlers.set(id, onInvalidate)
    activeSubs.set(id, { path, args })
    if (pipe !== null && authenticated) {
      safeSend({ type: 'subscribe', id, path, args }, connectGeneration)
    }
    // Otherwise replayed on (re)connect via sendSubscriptions().
  }

  function unsubscribe(id: string) {
    handlers.delete(id)
    activeSubs.delete(id)
    if (pipe !== null && authenticated) {
      safeSend({ type: 'unsubscribe', id }, connectGeneration)
    }
    // If never sent, removing from activeSubs is sufficient.
  }

  return {
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    isConnected: () => connected,
  }
}
