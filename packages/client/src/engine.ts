// @wystack/client — neutral reactive engine
//
// Owns the carrier-agnostic half of the v0.2 client (Spec ADR #11):
//   - Connection lifecycle (connect / disconnect, exponential-backoff reconnect)
//   - Auth handshake (send `auth`, await `authenticated`)
//   - Subscription registry (replay on (re)connect, invalidation dispatch). A
//     durable subscription-origin error (YW-108/YW-109) drops the sub and fires
//     optional `onError` so reconnect never replays a durably-failing sub; a
//     retryable subscription-origin error stays registered for reconnect replay.
//   - Call/result correlation (Spec ADR #9, YW-97 / T3d, YW-99): engine.call()
//     sends a `call` frame, registers a pending entry keyed by id, and
//     resolves/rejects it when the matching `result` or `error` frame arrives.
//
// Driven by a `Pipe<ServerMessage, ClientMessage>` factory — never imports a
// concrete transport. The WebSocket-backed factory lives in `ws.ts` (until the
// T3b adapter relocates it).
//
// Reconnect semantics mirror the previous `ws.ts`:
//   - close-code 4001 → latch `authFailed`, fire invalidations to nudge HTTP
//     refetch, stop retrying.
//   - any other close → exponential backoff (1s base, ×2 per attempt, capped
//     at 30s, [50%, 100%) of base jitter).
//   - `connectGeneration` invalidates stale async callbacks (token fetch,
//     pipe open) when a newer `connect()` or `disconnect()` has happened.
//
// Call correlation + generation discipline:
//   - Pending calls are stored in `pendingCalls` keyed by a monotonic id.
//   - Error frame routing uses the wire-level `kind` discriminant (YW-99):
//     `kind === 'subscription'` → subscription error, does NOT touch pendingCalls.
//     `kind === 'call'` or absent (backward-compat with older servers) → reject
//     the pending call by id, as today.
//   - On pipe close (`handleClose`) or explicit `disconnect()`, ALL pending
//     calls are rejected immediately (no hangs). See `rejectAllPending`.
//   - `handleClose` is already generation-gated (ownGeneration guard), so a
//     stale close from a previous generation cannot reject current-generation
//     pending calls.
//   - A `call()` issued when the pipe is not live (not connected, or auth
//     pending on a requiresAuth transport) is rejected immediately with a clear
//     error — buffering-until-connected is deferred (future work; one-shot
//     RPC retry semantics are non-trivial).

import type { Pipe, ServerMessage, ClientMessage } from '@wystack/transport'

type InvalidateHandler = () => void

/**
 * Per-subscription error callback (YW-108). Invoked once when a
 * durable `kind: 'subscription'` error frame arrives for a registered
 * subscription. The engine drops the subscription before calling this — it
 * will NOT be replayed on reconnect — so this is a terminal signal for that
 * sub id. Retryable subscription errors stay registered and do not invoke this
 * callback unless they exceed the bounded retryable-error cap.
 */
export type SubscriptionErrorHandler = (err: Error) => void

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
  /**
   * Register a reactive subscription. `onInvalidate` fires when the server
   * signals the sub's data is stale. Optional `onError` fires once if the server
   * durably rejects the subscription (`kind: 'subscription'` with
   * `retryable: false` or absent) or if retryable errors exceed the cap. Durable
   * failures are dropped so they are NOT replayed on reconnect.
   */
  subscribe(
    id: string,
    path: string,
    args: Record<string, unknown>,
    onInvalidate: InvalidateHandler,
    onError?: SubscriptionErrorHandler,
  ): void
  unsubscribe(id: string): void
  isConnected(): boolean
  /**
   * Send a `call` frame and return a Promise that resolves with the server's
   * `result.data`, or rejects on a matching `error` frame, pipe close, or
   * disconnect.
   *
   * Requires an open, authenticated pipe (or no-auth pipe that is connected).
   * Rejects immediately with `CallNotReadyError` if the pipe is not live — no
   * buffering (future work: queue-until-ready for long-lived IPC connections).
   *
   * The id is engine-internal and monotonically unique within the instance;
   * callers supply only `path` and `args`.
   */
  call(path: string, args: Record<string, unknown>): Promise<unknown>
}

const MAX_RECONNECT_DELAY_MS = 30_000
const DEFAULT_AUTH_ACK_TIMEOUT_MS = 10_000
const MAX_RETRYABLE_SUBSCRIPTION_ERRORS = 3

/**
 * Thrown (as a rejection) when `engine.call()` is invoked but the pipe is
 * not ready to accept frames. This covers:
 *   - Not connected yet (connect() not called, or still in the async open chain)
 *   - Auth pending (requiresAuth transport that hasn't received `authenticated`)
 *   - Disconnected or closed
 *
 * Buffering until ready is future work; the immediate-reject keeps the
 * pending-calls map from accumulating entries that can never be drained.
 */
export class CallNotReadyError extends Error {
  constructor(reason: string) {
    super(`engine.call: not ready — ${reason}`)
    this.name = 'CallNotReadyError'
  }
}

interface PendingCall {
  resolve: (data: unknown) => void
  reject: (err: unknown) => void
}

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
  // Per-subscription error callbacks (YW-108), keyed by sub id. Same lifecycle as
  // `handlers` — set in subscribe(), cleared in unsubscribe() and when a
  // subscription error drops the sub. Persists across reconnect (not cleared on
  // disconnect) so a replayed sub keeps its error handler.
  const errorHandlers = new Map<string, SubscriptionErrorHandler>()
  const activeSubs = new Map<
    string,
    { path: string; args: Record<string, unknown>; retryableErrors: number }
  >()

  // Pending call correlator: id → {resolve, reject}. Entries are added by
  // call() and removed by the matching `result` or `error` frame, or by
  // rejectAllPending() on close/disconnect.
  const pendingCalls = new Map<string, PendingCall>()
  // Monotonic call-id sequence — collision-free within this engine instance.
  let callSeq = 0

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

  /**
   * Reject every entry in `pendingCalls` with `reason` and clear the map.
   * Must be called from every path that closes or invalidates the current
   * connection — `handleClose` and `disconnect` — so callers of `call()` never
   * hang waiting for a result that will never arrive.
   *
   * Called AFTER the ownGeneration guard in `handleClose`, so a stale close
   * from a previous generation never touches current-generation pending calls.
   */
  function rejectAllPending(reason: Error) {
    if (pendingCalls.size === 0) return
    const snapshot = Array.from(pendingCalls.values())
    pendingCalls.clear()
    for (const entry of snapshot) entry.reject(reason)
  }

  function errorFromMessage(msg: Extract<ServerMessage, { type: 'error' }>): Error {
    const err = new Error(msg.error)
    if (msg.issues !== undefined) {
      ;(err as Error & { issues?: unknown[] }).issues = msg.issues
    }
    return err
  }

  function dropSubscriptionWithError(
    id: string,
    msg: Extract<ServerMessage, { type: 'error' }>,
  ): void {
    const onError = errorHandlers.get(id)
    // Cleanup FIRST so a throwing onError can't leave the sub registered (and
    // thus replayable on reconnect — the loop this branch exists to stop). The
    // maps are cleared before the callback runs, never after.
    handlers.delete(id)
    activeSubs.delete(id)
    errorHandlers.delete(id)
    if (onError !== undefined) {
      try {
        onError(errorFromMessage(msg))
      } catch {
        /* user onError threw — isolated; the engine keeps processing */
      }
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
      sendOrClose({ type: 'subscribe', id, path: sub.path, args: sub.args }, connectGeneration)
    }
  }

  /**
   * Tear down after a *send-side* failure (sync encode throw or async write
   * rejection). Unlike a transport-emitted close event — which `handleClose`
   * handles reactively, assuming the socket is already dead — a send failure
   * leaves the underlying socket OPEN. So we close the captured target before
   * synthesizing the close, or it leaks: `handleClose` detaches listeners and
   * nulls `pipe` but never calls `close()`, so a still-open socket would linger
   * while `scheduleReconnect` opens a second connection.
   *
   * `target` is captured at the call site (not read from `pipe`) for the same
   * reason `generation` is: by the time an async rejection settles, `pipe` may
   * point at a newer connection that must not be closed.
   */
  function closeAfterSendFailure(target: Pipe, generation: number) {
    target.close()
    handleClose({ code: 1006 }, generation)
  }

  /**
   * Close the connection if a send's returned promise rejects asynchronously —
   * a real write failure on a live carrier (transport death). Both `sendOrClose`
   * and `call()` route their async-rejection leg here so the generation is
   * *required* to be snapshotted at the call site (not read live at catch time):
   * a stale rejection from a superseded pipe must close THAT generation, never a
   * newer one. Taking `generation` as a parameter makes the snapshot structural.
   */
  function closeOnSendRejection(target: Pipe, sent: unknown, generation: number) {
    void Promise.resolve(sent).catch(() => {
      closeAfterSendFailure(target, generation)
    })
  }

  /**
   * Send a fire-and-forget control-plane frame (auth / subscribe / unsubscribe).
   * On ANY send failure — a synchronous encode throw OR an async send rejection —
   * the frame is unrecoverable and the connection is torn down (`handleClose`
   * with 1006) so the reconnect machinery takes over.
   *
   * NOT used by `call()`: a correlated RPC treats a synchronous encode throw as
   * bad caller args (reject that one call, keep the connection alive), which is a
   * different policy. `call()` does its own `target.send` + try/catch — see there.
   *
   * The synchronous try/catch matters: the transport encodes the frame inside
   * `send` (e.g. the WS adapter's `JSON.stringify(message)`), which throws
   * synchronously on a BigInt or cyclic arg. Wrapping only the returned promise
   * (`Promise.resolve(target.send(...))`) would let that sync throw escape.
   */
  function sendOrClose(message: ClientMessage, generation: number) {
    const target = pipe
    if (target === null) return
    try {
      closeOnSendRejection(target, target.send(message), generation)
    } catch {
      closeAfterSendFailure(target, generation)
    }
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
        const sub = activeSubs.get(msg.id)
        if (sub !== undefined) sub.retryableErrors = 0
        onSubscribed?.(msg.id)
        return
      }
      case 'invalidate': {
        const handler = handlers.get(msg.id)
        if (handler !== undefined) {
          // A throwing app-supplied invalidate handler must not propagate into
          // the engine's message loop — isolate it so later frames still process.
          try {
            handler()
          } catch {
            /* user onInvalidate threw — isolated; the engine keeps processing */
          }
        }
        return
      }
      case 'result': {
        // Correlate by id and resolve the pending call.
        const pending = pendingCalls.get(msg.id)
        if (pending !== undefined) {
          pendingCalls.delete(msg.id)
          pending.resolve(msg.data)
        }
        // Unknown id: the call may have been rejected already (close/disconnect
        // raced the result). Drop silently.
        return
      }
      case 'error': {
        // Route by the wire-level `kind` discriminant (YW-99):
        //   - `kind === 'subscription'` → subscription error; must NOT touch
        //     pendingCalls (a subscription id and a call id can now collide
        //     without mis-routing because the tag is self-describing).
        //   - `kind === 'call'` or absent (backward-compat with servers that
        //     predate YW-99) → reject the pending call by id, as today.
        //   - no `id` (connection-level error) → ignored here; the accompanying
        //     close event handles reconnect.
        if (msg.kind === 'subscription') {
          // Subscription-origin error (YW-108/YW-109). Durable errors drop the
          // sub so reconnect's sendSubscriptions() does NOT replay it. Retryable
          // errors keep the sub registered for reconnect replay, bounded by a
          // cap so a mislabeled-transient persistent failure cannot loop forever.
          //
          // This branch touches ONLY the subscription maps, never pendingCalls —
          // a subscription error must never reject an in-flight call sharing the
          // id (the YW-99 routing contract).
          if (msg.id !== undefined) {
            if (msg.retryable === true) {
              const sub = activeSubs.get(msg.id)
              if (sub !== undefined) {
                sub.retryableErrors++
                if (sub.retryableErrors <= MAX_RETRYABLE_SUBSCRIPTION_ERRORS) return
              }
            }
            dropSubscriptionWithError(msg.id, msg)
          }
          return
        }
        if (msg.id !== undefined) {
          const pending = pendingCalls.get(msg.id)
          if (pending !== undefined) {
            pendingCalls.delete(msg.id)
            pending.reject(errorFromMessage(msg))
          }
        }
        // Connection-level errors (no id, or id not in pending): ignored here;
        // the accompanying close event handles reconnect.
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

    // Reject all pending calls for this generation. Safe here because the
    // ownGeneration guard above guarantees we're closing the active connection,
    // not a stale one — so these are current-generation pending calls, not
    // calls from a newer connect that should remain live.
    rejectAllPending(new Error('pipe closed'))

    if (info.code === 4001) {
      authFailed = true
      // Fire invalidations so HTTP refetches surface the auth error to the
      // app's data layer. If HTTP also fails, the data layer raises; if it
      // succeeds, data is fresh but the realtime channel stays off until
      // disconnect() + connect() with a new token.
      for (const handler of handlers.values()) {
        try {
          handler()
        } catch {
          /* user invalidation handler threw — isolate siblings */
        }
      }
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
        sendOrClose({ type: 'auth', token: token ?? null }, generation)
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
    // Reject all pending calls immediately — disconnect means no result is coming.
    rejectAllPending(new Error('disconnected'))
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
    onError?: SubscriptionErrorHandler,
  ) {
    handlers.set(id, onInvalidate)
    // Keep errorHandlers symmetric with the unconditional overwrite of
    // `handlers`: a re-subscribe with the SAME id but no `onError` (without an
    // unsubscribe between) must CLEAR any stale handler from a prior registrant,
    // or that old closure would fire on the new subscription's error frame.
    if (onError !== undefined) {
      errorHandlers.set(id, onError)
    } else {
      errorHandlers.delete(id)
    }
    activeSubs.set(id, { path, args, retryableErrors: 0 })
    if (pipe !== null && authenticated) {
      sendOrClose({ type: 'subscribe', id, path, args }, connectGeneration)
    }
    // Otherwise replayed on (re)connect via sendSubscriptions().
  }

  function unsubscribe(id: string) {
    handlers.delete(id)
    errorHandlers.delete(id)
    activeSubs.delete(id)
    if (pipe !== null && authenticated) {
      sendOrClose({ type: 'unsubscribe', id }, connectGeneration)
    }
    // If never sent, removing from activeSubs is sufficient.
  }

  function call(path: string, args: Record<string, unknown>): Promise<unknown> {
    // Require a live, authenticated (or no-auth) pipe. Reject immediately if
    // not ready — no buffering (future work: queue-until-ready, see module doc).
    if (pipe === null || !connected) {
      return Promise.reject(new CallNotReadyError('not connected'))
    }
    if (requiresAuth && !authenticated) {
      return Promise.reject(new CallNotReadyError('auth handshake pending'))
    }

    // Mint a monotonically unique id for this call within the engine instance.
    // The wire-level `kind` discriminant on `error` frames (YW-99) routes errors
    // by origin (call vs subscription), so ids no longer need to be in a reserved
    // namespace — any collision-free counter works.
    const id = (++callSeq).toString(36)
    const target = pipe
    // Snapshot the generation NOW (mirrors sendOrClose's param): the async
    // rejection leg below must close the generation this call rode on, never a
    // newer one a reconnect may have installed by the time the promise settles.
    const generation = connectGeneration
    return new Promise<unknown>((resolve, reject) => {
      pendingCalls.set(id, { resolve, reject })
      // call() does NOT use sendOrClose: a correlated RPC must NOT tear down the
      // connection on a bad arg. A synchronous encode throw (BigInt/cyclic arg in
      // `JSON.stringify`) is bad caller input, not transport death — reject THIS
      // call, delete its pending entry (or it leaks an unreachable resolver), and
      // leave the connection healthy. An async send rejection IS transport death:
      // route it through closeOnSendRejection (shared with sendOrClose).
      try {
        closeOnSendRejection(target, target.send({ type: 'call', id, path, args }), generation)
      } catch (err) {
        pendingCalls.delete(id)
        reject(err)
      }
    })
  }

  return {
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    isConnected: () => connected,
    call,
  }
}
