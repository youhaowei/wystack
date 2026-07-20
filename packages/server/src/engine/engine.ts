// @wystack/server — Engine (Session + Dispatch over a Pipe)

import {
  parseClientMessage,
  parseEnvelope,
  REACTIVITY_NOT_ENABLED,
  type ClientMessage,
  type ServerMessage,
  type Pipe,
} from '@wystack/transport'
import type { WyStackApp } from '../create'
import { ValidationError } from '../validation'
import { PermissionDeniedError } from '../permissions'
import { createDispatch, type Dispatch } from './dispatch'
import { Session, type CloseReason, type SessionOptions } from './session'
import type { SubscriptionStore } from './subscription-store'

export interface AttachEngineOptions extends SessionOptions {
  app: WyStackApp
  /**
   * Max ms to wait for the client's first `auth` frame after the connection
   * opens. Only armed when `resolveContext` is configured. A timeout closes the
   * connection with the `transient` reason (the client retries). Default 10_000,
   * matching the shipped `routes.ts` handshake.
   */
  authTimeoutMs?: number
  /**
   * Invoked just before the Engine closes the pipe, with the transport-neutral
   * reason. The adapter maps it to a wire close (`auth-failed → 4001`,
   * `transient → 4002`). Optional — trusted transports may ignore it. The
   * Engine always also calls `pipe.close()` after this hook.
   */
  onClose?: (reason: CloseReason) => void
  /**
   * Shared subscription registry for the reactive tier. Must be the same
   * instance across all connections on a server so `getAffected` queries the
   * full live set. Supply alongside `publishInvalidation` to enable the
   * reactive tier; omit either to keep today's RPC-only behaviour.
   */
  subscriptionStore?: SubscriptionStore
  /**
   * Emit a write-event into the shared invalidation channel. Called after each
   * mutation with the set of tables written. This is the producer side of
   * `DispatchInvalidationSource.emit` — callers own the source and register the
   * router (e.g. `createInvalidationRouter`) once before attaching connections.
   *
   * Supply alongside `subscriptionStore` to enable the reactive tier.
   */
  publishInvalidation?: (tables: Set<string>) => void
}

/** Handle to a running Engine attachment. `detach` tears it down idempotently. */
export interface EngineHandle {
  readonly session: Session
  detach(): void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Attach the Engine to a Pipe. Returns a handle whose `detach()` removes the
 * inbound handler and closes the pipe (idempotent).
 *
 * Inbound frames are parsed with `@wystack/transport`'s strict
 * `parseClientMessage`. An unparseable or unknown-shape frame is a protocol
 * violation: pre-auth it closes the connection (`auth-failed`); post-auth it
 * gets a connection-level `error` frame and the connection stays open — parity
 * with the shipped `routes.ts` pre/post-auth split.
 */
export function attachEngine(pipe: Pipe, opts: AttachEngineOptions): EngineHandle {
  const { app, authTimeoutMs = 10_000, onClose, subscriptionStore, publishInvalidation } = opts
  const dispatch: Dispatch = createDispatch(app)
  const session = new Session(opts)

  // Reactive tier is enabled only when BOTH ports are wired.
  const reactiveEnabled = subscriptionStore !== undefined && publishInvalidation !== undefined

  let closed = false
  // Set when the inbound handler is registered (below). Held in a mutable ref so
  // every close path can unsubscribe it, not just `detach`.
  let unsubscribe: (() => void) | null = null
  const send = (msg: ServerMessage): void => {
    // Outbound frames race against unrelated closes; swallow the post-close
    // failure. `Pipe.send` is `void | Promise<void>` (sync loopback today, async
    // WS/IPC next), so guard BOTH a synchronous throw and a rejected promise —
    // a bare `try/catch` would let an async rejection escape as unhandled. A
    // conformant pipe is a silent no-op after close, so this rarely fires; it is
    // the safety net for adapters that reject instead. The one ack that needs
    // the failure observed (the committing handshake ack) does not use this
    // helper — it awaits `pipe.send` directly to close `transient` on failure.
    try {
      const r = pipe.send(msg)
      if (r instanceof Promise) r.catch(() => {})
    } catch {
      /* pipe closed */
    }
  }

  // --- Reactive tier: per-connection subscription bookkeeping ---
  //
  // `mySubIds`          — IDs of subscriptions registered by this connection.
  //                       Used during teardown to remove only this connection's
  //                       entries.
  // `pendingSubAttempts`— id → attempt token for in-flight subscribes
  //                       (resolveSubContext / app.call in progress). A newer
  //                       subscribe for the same id replaces the token so stale
  //                       async tails cannot register, delete, or emit a
  //                       terminal error for the superseded attempt.
  //                       known-debt: flag-check cancellation, not AbortSignal.
  //                       The underlying context resolution keeps running to
  //                       completion; we bail at await boundaries. See YW-63.
  const mySubIds = new Set<string>()
  const pendingSubAttempts = new Map<string, number>()
  let nextSubAttempt = 0

  function clearSubscriptionOwnership(id: string): void {
    if (mySubIds.has(id)) {
      subscriptionStore!.remove(id)
      mySubIds.delete(id)
    }
  }

  function startSubscribeAttempt(id: string): number {
    const attempt = ++nextSubAttempt
    pendingSubAttempts.set(id, attempt)
    clearSubscriptionOwnership(id)
    return attempt
  }

  function isCurrentSubscribeAttempt(id: string, attempt: number): boolean {
    return pendingSubAttempts.get(id) === attempt
  }

  function finishSubscribeAttempt(id: string, attempt: number): void {
    if (isCurrentSubscribeAttempt(id, attempt)) pendingSubAttempts.delete(id)
  }

  // Shared teardown: flip the closed guard, disarm the handshake timer, drop
  // the inbound handler, and (when reactive is enabled) remove this connection's
  // subscriptions from the shared store. Both close paths (engine-initiated
  // `closeWith` and caller-initiated `detach`) run this so a leaked `onMessage`
  // handler never outlives the connection. Idempotent via the `closed` guard.
  const teardown = (): void => {
    if (closed) return
    closed = true
    if (timeout !== null) clearTimeout(timeout)
    unsubscribe?.()
    // Reactive cleanup: remove all subscriptions owned by this connection.
    // Drop pendingSubAttempts so any in-flight bail-checks see "not current".
    if (reactiveEnabled) {
      pendingSubAttempts.clear()
      for (const id of mySubIds) {
        subscriptionStore!.remove(id)
      }
      mySubIds.clear()
    }
  }

  /** Close once: tear down, fire the adapter's reason hook, then close the pipe. */
  const closeWith = (reason: CloseReason): void => {
    if (closed) return
    teardown()
    onClose?.(reason)
    void pipe.close()
  }

  // Arm the handshake timer only when auth is required. A client that never
  // sends `auth` trips this; the connection closes transient (client retries).
  const timeout: ReturnType<typeof setTimeout> | null = session.requiresAuth
    ? setTimeout(() => closeWith('transient'), authTimeoutMs)
    : null

  async function handleAuth(rawToken: unknown): Promise<void> {
    const outcome = await session.handleAuth(rawToken)
    if (closed) return
    if (outcome.kind === 'close') {
      // TODO: replace with @wystack/log once server logging lands. Log only that
      // auth failed — never the token — to avoid leaking credentials.
      // eslint-disable-next-line no-console
      console.warn('[wystack/server] engine auth failed')
      closeWith(outcome.reason)
      return
    }
    if (!outcome.committed) {
      // Idempotent ACK (repeat frame, or no-auth server). Swallow a post-close
      // throw — nothing was committed, so a dead socket is harmless.
      send({ type: 'authenticated' })
      return
    }

    // Committing ACK: auth SUCCEEDED. Disarm the handshake timer, then send the
    // ack with explicit failure handling — parity with routes.ts. If the
    // transport died between a successful resolve and the ack, that is a network
    // flake, not an auth failure: close `transient` so the client retries,
    // rather than silently dropping the ack and stranding it on its ack timer.
    if (timeout !== null) clearTimeout(timeout)
    try {
      await pipe.send({ type: 'authenticated' } satisfies ServerMessage)
    } catch {
      if (!closed) closeWith('transient')
    }
  }

  async function handleCall(msg: Extract<ClientMessage, { type: 'call' }>): Promise<void> {
    let context: Record<string, unknown>
    try {
      context = await session.resolveSubContext()
    } catch (err) {
      send({ type: 'error', kind: 'call', id: msg.id, error: errorMessage(err) })
      return
    }
    if (closed) return
    try {
      const { result, tablesWritten } = await dispatch(msg.path, msg.args, context)
      if (closed) return
      // When the reactive tier is wired, emit the write-set to fan out
      // invalidations to any affected subscriptions. Fire-and-forget: the router
      // (createInvalidationRouter) handles per-entry re-queries and delivery.
      if (reactiveEnabled && tablesWritten.size > 0) {
        publishInvalidation!(tablesWritten)
      }
      send({ type: 'result', id: msg.id, data: result })
    } catch (err) {
      if (closed) return
      const payload: ServerMessage = {
        type: 'error',
        kind: 'call',
        id: msg.id,
        error: errorMessage(err),
      }
      if (err instanceof ValidationError) payload.issues = err.issues
      send(payload)
    }
  }

  async function handleSubscribe(
    msg: Extract<ClientMessage, { type: 'subscribe' }>,
  ): Promise<void> {
    const id = msg.id
    const path = msg.path
    const args = (msg.args ?? {}) as Record<string, unknown>
    const attempt = startSubscribeAttempt(id)

    const fn = app.functions.get(path)
    if (!fn || fn.type !== 'query') {
      finishSubscribeAttempt(id, attempt)
      send({
        type: 'error',
        kind: 'subscription',
        id,
        retryable: false,
        error: `Unknown query: ${path}`,
      })
      return
    }

    let context: Record<string, unknown>
    try {
      context = await session.resolveSubContext()
    } catch (err) {
      if (!isCurrentSubscribeAttempt(id, attempt)) return
      finishSubscribeAttempt(id, attempt)
      const payload: ServerMessage = {
        type: 'error',
        kind: 'subscription',
        id,
        retryable: !(err instanceof ValidationError || err instanceof PermissionDeniedError),
        error: errorMessage(err),
      }
      if (err instanceof ValidationError) payload.issues = err.issues
      send(payload)
      return
    }

    if (closed || !isCurrentSubscribeAttempt(id, attempt)) return

    try {
      const { tablesRead } = await app.call(path, args, context)
      if (closed || !isCurrentSubscribeAttempt(id, attempt)) return
      finishSubscribeAttempt(id, attempt)

      subscriptionStore!.add({
        id,
        functionPath: path,
        args,
        context,
        tablesWatched: tablesRead,
        send: (payload: unknown) => send(payload as ServerMessage),
      })
      mySubIds.add(id)
      send({ type: 'subscribed', id })
    } catch (err) {
      if (!isCurrentSubscribeAttempt(id, attempt)) return
      finishSubscribeAttempt(id, attempt)
      const payload: ServerMessage = {
        type: 'error',
        kind: 'subscription',
        id,
        retryable: !(err instanceof ValidationError || err instanceof PermissionDeniedError),
        error: errorMessage(err),
      }
      if (err instanceof ValidationError) payload.issues = err.issues
      send(payload)
    }
  }

  /**
   * Handle an `unsubscribe` frame. Cancels in-flight subscribes (removes from
   * pendingSubAttempts so the await-tail sees "not current") and removes any
   * committed entry from the shared store.
   */
  function handleUnsubscribe(msg: Extract<ClientMessage, { type: 'unsubscribe' }>): void {
    const id = msg.id
    // Cancel a pending (in-flight) subscribe before it finishes.
    pendingSubAttempts.delete(id)
    // Remove a committed subscription from the shared store.
    clearSubscriptionOwnership(id)
  }

  function handleMessage(raw: unknown): void {
    if (closed) return

    // A non-string frame (structured-clone IPC payload, etc.) is serialized for
    // the parser. `JSON.stringify` can throw on a BigInt or circular value — a
    // malformed frame must route through the invalid-frame path, not crash the
    // inbound callback. `stringify` can also return `undefined` (e.g. a bare
    // function); treat that as malformed too.
    let data: string | null
    if (typeof raw === 'string') {
      data = raw
    } else {
      try {
        data = JSON.stringify(raw) ?? null
      } catch {
        data = null
      }
    }

    // Lenient envelope parse FIRST — mirrors routes.ts, which gates frames on a
    // local envelope check (JSON → plain object → string `type`) and validates
    // payload fields per-handler. This is deliberately NOT the strict
    // `parseClientMessage`: routing `auth` through the strict parser would reject
    // a missing or non-string `token` as a malformed frame and terminally close
    // a client the shipped server authenticates as anonymous (it coerces such
    // tokens to null in `Session.handleAuth`). Auth-frame token leniency is the
    // Session's job, not the parser's — so the envelope check decides only the
    // frame `type`, and `handleAuth` does the routes.ts-equivalent coercion.
    const envelope = data === null ? null : parseEnvelope(data)

    if (envelope === null) {
      // Unparseable, null, array, primitive, or non-string `type`. Pre-auth →
      // protocol violation, close terminal. Post-auth → connection-level error
      // frame, stay open. Parity with routes.ts:397.
      if (!session.authenticated) {
        closeWith('auth-failed')
        return
      }
      send({ type: 'error', error: 'invalid message' })
      return
    }

    // `auth` is the only frame allowed across the unauthenticated boundary.
    // Hand the raw token to the Session, which coerces missing/empty/non-string
    // to null (anonymous) exactly as routes.ts does.
    if (envelope.type === 'auth') {
      void handleAuth(envelope.token)
      return
    }

    if (!session.authenticated) {
      closeWith('auth-failed')
      return
    }

    // Post-auth: strict-parse the payload. The typed client always sends
    // well-formed `call`/`subscribe`/`unsubscribe` frames; a malformed one
    // post-auth gets an error frame and the connection stays open. `data` is
    // non-null here — `envelope !== null` implies it parsed from a string.
    const msg = parseClientMessage(data as string)
    if (msg === null) {
      send({ type: 'error', error: 'invalid message' })
      return
    }

    switch (msg.type) {
      case 'auth':
        // Already handled above via the envelope; unreachable here. A repeat
        // auth frame post-auth is routed by the envelope branch, not this one.
        return
      case 'call':
        void handleCall(msg)
        return
      case 'subscribe':
        if (!reactiveEnabled) {
          // Reactive tier not wired (Spec ADR #12). The capability-discovery floor.
          send({
            type: 'error',
            kind: 'subscription',
            id: msg.id,
            retryable: false,
            error: REACTIVITY_NOT_ENABLED,
          })
          return
        }
        void handleSubscribe(msg)
        return
      case 'unsubscribe':
        if (!reactiveEnabled) {
          // No reactive tier means no subscription to cancel — tolerate silently,
          // matching the shipped server's unknown-id tolerance.
          return
        }
        handleUnsubscribe(msg)
        return
    }
  }

  unsubscribe = pipe.onMessage(handleMessage)

  return {
    session,
    detach() {
      if (closed) return
      teardown()
      void pipe.close()
    },
  }
}
