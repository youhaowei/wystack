// @wystack/server — Engine (Session + Dispatch over a Pipe)
//
// `attachEngine(pipe, opts)` wires the two-timescale Engine (Spec ADR #8) onto
// any `Pipe`: Session for the connection-timescale auth gate, Dispatch for
// request-timescale RPC. It is the transport-neutral entry point — the loopback
// pair drives it in tests today; the Hono WS adapter and Electron IPC adapter
// drive it next (YW-57, T5/T6), each supplying its own close-code mapping.
//
// Tier model (Spec ADR #12): the RPC tier (`call` → `result`) is always on. The
// reactive tier (`subscribe`/`unsubscribe`/`invalidate`) is opt-in; this Engine
// does not wire it, so any `subscribe` gets `error{REACTIVITY_NOT_ENABLED}`.
// YW-62 adds the SubscriptionStore + invalidation ports behind this seam.

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
import { createDispatch, type Dispatch } from './dispatch'
import { Session, type CloseReason, type SessionOptions } from './session'

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
  const { app, authTimeoutMs = 10_000, onClose } = opts
  const dispatch: Dispatch = createDispatch(app)
  const session = new Session(opts)

  let closed = false
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

  /** Close once: fire the adapter's reason hook, then close the pipe. */
  const closeWith = (reason: CloseReason): void => {
    if (closed) return
    closed = true
    if (timeout !== null) clearTimeout(timeout)
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
      send({ type: 'error', id: msg.id, error: errorMessage(err) })
      return
    }
    if (closed) return
    try {
      // RPC drops `tablesWritten`: a `call` to a mutation produces it, but the
      // reactive tier (the SubscriptionStore that would consume it) is not wired
      // here. Invalidation lands in YW-62. RPC returns only the result.
      const { result } = await dispatch(msg.path, msg.args, context)
      if (closed) return
      send({ type: 'result', id: msg.id, data: result })
    } catch (err) {
      if (closed) return
      const payload: ServerMessage = { type: 'error', id: msg.id, error: errorMessage(err) }
      if (err instanceof ValidationError) payload.issues = err.issues
      send(payload)
    }
  }

  function handleMessage(raw: unknown): void {
    if (closed) return
    const data = typeof raw === 'string' ? raw : JSON.stringify(raw)

    // Lenient envelope parse FIRST — mirrors routes.ts, which gates frames on a
    // local envelope check (JSON → plain object → string `type`) and validates
    // payload fields per-handler. This is deliberately NOT the strict
    // `parseClientMessage`: routing `auth` through the strict parser would reject
    // a missing or non-string `token` as a malformed frame and terminally close
    // a client the shipped server authenticates as anonymous (it coerces such
    // tokens to null in `Session.handleAuth`). Auth-frame token leniency is the
    // Session's job, not the parser's — so the envelope check decides only the
    // frame `type`, and `handleAuth` does the routes.ts-equivalent coercion.
    const envelope = parseEnvelope(data)

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
    // post-auth gets an error frame and the connection stays open.
    const msg = parseClientMessage(data)
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
        // Reactive tier not wired (Spec ADR #12). The capability-discovery floor.
        send({ type: 'error', id: msg.id, error: REACTIVITY_NOT_ENABLED })
        return
      case 'unsubscribe':
        // No reactive tier means no subscription to cancel — tolerate silently,
        // matching the shipped server's unknown-id tolerance.
        return
    }
  }

  const unsubscribe = pipe.onMessage(handleMessage)

  return {
    session,
    detach() {
      if (closed) return
      closed = true
      if (timeout !== null) clearTimeout(timeout)
      unsubscribe()
      void pipe.close()
    },
  }
}
