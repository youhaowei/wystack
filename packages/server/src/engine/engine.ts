// @wystack/server — Engine (Session + Dispatch over a Pipe)
//
// `attachEngine(pipe, opts)` wires the two-timescale Engine (Spec ADR #8) onto
// any `Pipe`: Session for the connection-timescale auth gate, Dispatch for
// request-timescale RPC. It is the transport-neutral entry point — the loopback
// pair drives it in tests today; the Hono WS adapter and Electron IPC adapter
// drive it next (YW-57, T5/T6), each supplying its own close-code mapping.
//
// Tier model (Spec ADR #12): the RPC tier (`call` → `result`) is always on. The
// reactive tier (`subscribe`/`unsubscribe`/`invalidate`) is opt-in; transports
// pass a ReactiveTier when they support subscriptions, otherwise `subscribe`
// gets `error{REACTIVITY_NOT_ENABLED}`.

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
   * Optional reactive tier shared by adapters that support subscriptions.
   * Omitted transports stay RPC-only and answer `subscribe` with
   * REACTIVITY_NOT_ENABLED.
   */
  reactive?: ReactiveTier
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

interface ReactiveSubscription {
  id: string
  functionPath: string
  args: Record<string, unknown>
  context: Record<string, unknown>
  tablesWatched: Set<string>
  pipe: Pipe<unknown, ServerMessage>
}

export interface ReactiveTier {
  add(sub: ReactiveSubscription): void
  remove(id: string): void
  invalidate(writtenTables: Set<string>): Promise<void>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function safeSend(pipe: Pipe<unknown, ServerMessage>, msg: ServerMessage): void {
  try {
    const r = pipe.send(msg)
    if (r instanceof Promise) r.catch(() => {})
  } catch {
    /* pipe closed */
  }
}

/**
 * Reactive subscription registry shared by an app's WS connections and HTTP
 * mutation dispatch. Keeps subscription state out of Hono routes while
 * preserving the v0.2 signal-only invalidation behavior.
 */
export function createReactiveTier(app: WyStackApp): ReactiveTier {
  const subToPipe = new Map<string, Pipe<unknown, ServerMessage>>()

  return {
    add(sub) {
      app.subscriptions.add({
        id: sub.id,
        functionPath: sub.functionPath,
        args: sub.args,
        context: sub.context,
        tablesWatched: sub.tablesWatched,
      })
      subToPipe.set(sub.id, sub.pipe)
    },

    remove(id) {
      app.subscriptions.remove(id)
      subToPipe.delete(id)
    },

    async invalidate(writtenTables) {
      const affected = app.subscriptions.getAffectedSubscriptions(writtenTables)

      await Promise.allSettled(
        affected.map(async (sub) => {
          const pipe = subToPipe.get(sub.id)
          if (!pipe) return

          try {
            const { tablesRead } = await app.call(sub.functionPath, sub.args, sub.context)
            sub.tablesWatched = tablesRead
          } catch {
            // Keep existing table watches; the client refetch surfaces the error.
          }

          safeSend(pipe, { type: 'invalidate', id: sub.id })
        }),
      )
    },
  }
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
  const { app, authTimeoutMs = 10_000, onClose, reactive } = opts
  const dispatch: Dispatch = createDispatch(app)
  const session = new Session(opts)

  let closed = false
  const subIds = new Set<string>()
  const pendingSubIds = new Set<string>()
  // Set when the inbound handler is registered (below). Held in a mutable ref so
  // every close path can unsubscribe it, not just `detach`.
  let unsubscribe: (() => void) | null = null
  const send = (msg: ServerMessage): void => safeSend(pipe, msg)

  // Shared teardown: flip the closed guard, disarm the handshake timer, and drop
  // the inbound handler. Both close paths (engine-initiated `closeWith` and
  // caller-initiated `detach`) run this so a leaked `onMessage` handler never
  // outlives the connection. Idempotent via the `closed` guard.
  const teardown = (): void => {
    if (closed) return
    closed = true
    if (timeout !== null) clearTimeout(timeout)
    pendingSubIds.clear()
    for (const id of subIds) reactive?.remove(id)
    subIds.clear()
    unsubscribe?.()
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
      send({ type: 'error', id: msg.id, error: errorMessage(err) })
      return
    }
    if (closed) return
    try {
      const { result, tablesWritten } = await dispatch(msg.path, msg.args, context)
      if (closed) return
      if (reactive !== undefined && tablesWritten.size > 0) {
        await reactive.invalidate(tablesWritten)
        if (closed) return
      }
      send({ type: 'result', id: msg.id, data: result })
    } catch (err) {
      if (closed) return
      const payload: ServerMessage = { type: 'error', id: msg.id, error: errorMessage(err) }
      if (err instanceof ValidationError) payload.issues = err.issues
      send(payload)
    }
  }

  async function handleSubscribe(
    msg: Extract<ClientMessage, { type: 'subscribe' }>,
  ): Promise<void> {
    if (reactive === undefined) {
      send({ type: 'error', id: msg.id, error: REACTIVITY_NOT_ENABLED })
      return
    }

    const fn = app.functions.get(msg.path)
    if (!fn || fn.type !== 'query') {
      send({ type: 'error', id: msg.id, error: `Unknown query: ${msg.path}` })
      return
    }

    pendingSubIds.add(msg.id)

    let context: Record<string, unknown>
    try {
      context = await session.resolveSubContext()
    } catch (err) {
      pendingSubIds.delete(msg.id)
      send({ type: 'error', id: msg.id, error: errorMessage(err) })
      return
    }

    if (closed || !pendingSubIds.has(msg.id)) return

    try {
      const { tablesRead } = await dispatch(msg.path, msg.args, context)
      if (closed || !pendingSubIds.has(msg.id)) return
      pendingSubIds.delete(msg.id)
      reactive.add({
        id: msg.id,
        functionPath: msg.path,
        args: msg.args,
        context,
        tablesWatched: tablesRead,
        pipe,
      })
      subIds.add(msg.id)
      send({ type: 'subscribed', id: msg.id })
    } catch (err) {
      pendingSubIds.delete(msg.id)
      const payload: ServerMessage = { type: 'error', id: msg.id, error: errorMessage(err) }
      if (err instanceof ValidationError) payload.issues = err.issues
      send(payload)
    }
  }

  function handleUnsubscribe(msg: Extract<ClientMessage, { type: 'unsubscribe' }>): void {
    pendingSubIds.delete(msg.id)
    if (!reactive) return
    reactive.remove(msg.id)
    subIds.delete(msg.id)
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
        void handleSubscribe(msg)
        return
      case 'unsubscribe':
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
