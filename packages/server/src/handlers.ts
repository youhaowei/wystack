/**
 * Effect-shaped handlers for the WS auth + subscribe frames.
 *
 * Boundary: effect lives here, in errors.ts, and (called from) routes.ts via
 * `Effect.runPromise`. It does not appear in any module re-exported from
 * index.ts.
 *
 * Slice 1 of the effect spike (see worktree SPIKE-EVAL.md). Compare against
 * the imperative versions on `main` (handleAuthFrame, handleSubscribe in
 * routes.ts:232–365). The question this slice answers: does Effect.interrupt +
 * acquireRelease give a real cancellation/cleanup win over the existing
 * pendingSubIds flag-check pattern, given `resolveContext` is an unbounded
 * native Promise (no AbortSignal plumbing in this spike).
 */
import { Effect, Cause, Exit } from 'effect'
import type { WSContext } from 'hono/ws'
import { AuthError, ValidationError, RuntimeError, messageOf, type ServerError } from './errors'
import { ValidationError as LegacyValidationError } from './validation'
import type { WyStackApp } from './create'

export interface Connection {
  authenticated: boolean
  token: string | null
  upgradeRequest: Request
  timeout: ReturnType<typeof setTimeout> | null
  subIds: Set<string>
  pendingSubIds: Set<string>
}

/** Dependencies the effect handlers need. Closed-over by the route builder. */
export interface HandlerDeps {
  app: WyStackApp
  resolveSubContext: (rawSocket: object, token: string | null) => Promise<Record<string, unknown>>
  addSub: (id: string, ws: WSContext) => void
  rawToConnection: Map<object, Connection>
  safeSend: (ws: WSContext, payload: unknown) => void
}

/**
 * Wrap a thrown unknown in a tagged error.
 * Preserves ValidationError -> ValidationError (with issues).
 * Everything else -> RuntimeError.
 */
function tagThrown(err: unknown): ServerError {
  if (err instanceof LegacyValidationError) {
    return new ValidationError({ message: err.message, issues: err.issues })
  }
  return new RuntimeError({ message: messageOf(err), cause: err })
}

/**
 * handleAuthFrame, effect-shaped.
 *
 * Mirrors the imperative version's race semantics: two concurrent auth frames
 * can both pass the pre-await `authenticated === false` check; the slower one
 * must NOT overwrite the winning token. We commit `conn.token` only after the
 * post-await re-check confirms we won the race.
 *
 * Cancellation surface: if the socket closes mid-flight, the route builder
 * interrupts the running fiber via the close handler. `Effect.interrupt`
 * unwinds any finalizers we set up — but note (per spike rule) that
 * `resolveSubContext` itself is a native Promise with no AbortSignal: it
 * runs to completion, we just don't act on its result.
 */
export function handleAuthFrameE(
  deps: HandlerDeps,
  msg: Record<string, unknown>,
  ws: WSContext,
  conn: Connection,
  rawSocket: object,
): Effect.Effect<void, ServerError> {
  return Effect.gen(function* () {
    // Already-authenticated path: idempotent ACK, no token adoption.
    if (conn.authenticated) {
      deps.safeSend(ws, { type: 'authenticated' })
      return
    }

    const rawToken = msg.token
    const token = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null

    // Run resolveContext. If it rejects, tag as AuthError.
    const result = yield* Effect.tryPromise({
      try: () => deps.resolveSubContext(rawSocket, token),
      catch: (cause) => new AuthError({ reason: messageOf(cause), cause }),
    }).pipe(
      Effect.catchTag('AuthError', (err) => {
        // Log message only — not full error — to avoid leaking token/header values
        // that resolveContext implementations may embed.
        console.warn('[wystack/server] WS auth failed:', err.reason)
        // Guard: connection may have been torn down or won by a concurrent frame.
        if (deps.rawToConnection.has(rawSocket) && !conn.authenticated) {
          ws.close(4001, 'auth failed')
        }
        // Swallow the error — we've already closed the socket; the route
        // builder doesn't need to see it.
        return Effect.void
      }),
      Effect.map(() => 'resolved' as const),
    )

    if (result !== 'resolved') return

    // Post-await guards: connection torn down, or concurrent frame won.
    if (!deps.rawToConnection.has(rawSocket)) return
    if (conn.authenticated) {
      deps.safeSend(ws, { type: 'authenticated' })
      return
    }

    // Won the race — commit.
    conn.token = token
    if (conn.timeout) clearTimeout(conn.timeout)
    conn.timeout = null
    conn.authenticated = true

    // Use raw ws.send (not safeSend) so we can catch a post-close throw and
    // close 4002 — the auth succeeded but transport died, client should retry.
    yield* Effect.try({
      try: () => ws.send(JSON.stringify({ type: 'authenticated' })),
      catch: (cause) => new RuntimeError({ message: 'ack send failed', cause }),
    }).pipe(
      Effect.catchAll(() => {
        ws.close(4002, 'ack send failed')
        return Effect.void
      }),
    )
  })
}

/**
 * handleSubscribe, effect-shaped.
 *
 * Two cleanup obligations on every exit (success, error, interrupt):
 *   - drop the sub id from conn.pendingSubIds
 *   - on any error, send an `error` frame to the client
 *
 * The imperative version handles these via three call sites:
 *   - line 330: catch on resolveSubContext -> delete + send
 *   - line 344: success path -> delete (no send)
 *   - line 356: .catch on app.call -> delete + send
 *
 * Goal: collapse to one cleanup site via Effect.ensuring / Effect.acquireRelease.
 */
export function handleSubscribeE(
  deps: HandlerDeps,
  msg: Record<string, unknown>,
  ws: WSContext,
  conn: Connection,
  rawSocket: object,
): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    // Runtime narrowing on id/path. Non-strings bypass pendingSubIds reference-
    // identity guards and silently orphan the sub.
    if (typeof msg.id !== 'string' || typeof msg.path !== 'string') {
      deps.safeSend(ws, {
        type: 'error',
        id: typeof msg.id === 'string' ? msg.id : undefined,
        error: 'invalid subscribe message',
      })
      return
    }
    const id = msg.id
    const path = msg.path
    const args = (msg.args ?? {}) as Record<string, unknown>

    const fn = deps.app.functions.get(path)
    if (!fn || fn.type !== 'query') {
      deps.safeSend(ws, { type: 'error', id, error: `Unknown query: ${path}` })
      return
    }

    // The core subscribe pipeline. Wrapped in Effect.ensuring so the
    // pendingSubIds cleanup runs on every termination — success, failure,
    // or interrupt (close mid-flight, unsubscribe mid-flight).
    const pipeline = Effect.gen(function* () {
      conn.pendingSubIds.add(id)

      const context = yield* Effect.tryPromise({
        try: () => deps.resolveSubContext(rawSocket, conn.token),
        catch: (cause) => tagThrown(cause),
      })

      // Mid-await cancellation surface: unsubscribe may have arrived during
      // resolveSubContext. The imperative code checks pendingSubIds; we
      // preserve that semantics here. (Effect.interrupt is a separate
      // mechanism — see route builder, where socket close interrupts the fiber.)
      if (!conn.pendingSubIds.has(id)) {
        return yield* Effect.interrupt
      }

      const { tablesRead } = yield* Effect.tryPromise({
        try: () => deps.app.call(path, args, context),
        catch: (cause) => tagThrown(cause),
      })

      // Post-await guards (connection torn down, or unsubscribe arrived).
      if (!deps.rawToConnection.has(rawSocket) || !conn.pendingSubIds.has(id)) {
        return yield* Effect.interrupt
      }

      deps.app.subscriptions.add({
        id,
        functionPath: path,
        args,
        context,
        tablesWatched: tablesRead,
      })
      deps.addSub(id, ws)
      deps.safeSend(ws, { type: 'subscribed', id })
    })

    // Single cleanup site: drop from pendingSubIds + emit error frame on error.
    yield* pipeline.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          // Always: drop from pendingSubIds. Idempotent — already removed
          // by unsubscribe path is a no-op.
          conn.pendingSubIds.delete(id)

          if (Exit.isFailure(exit)) {
            // Interrupt is intentional cancellation (unsubscribe / close).
            // Don't send an error frame — the client either initiated this
            // (unsubscribe) or is gone (close).
            if (Cause.isInterruptedOnly(exit.cause)) return

            // Tagged failure: send error frame with the right shape.
            const failure = Cause.failureOption(exit.cause)
            if (failure._tag === 'Some') {
              const err = failure.value
              const errorText =
                err._tag === 'ValidationError' || err._tag === 'RuntimeError'
                  ? err.message
                  : err.reason
              const payload: Record<string, unknown> = {
                type: 'error',
                id,
                error: errorText,
              }
              if (err._tag === 'ValidationError') payload.issues = err.issues
              deps.safeSend(ws, payload)
              return
            }

            // Defect (unexpected throw inside the effect). Send a generic error.
            deps.safeSend(ws, { type: 'error', id, error: 'internal error' })
          }
        }),
      ),
      // Pipeline's error channel is tagged but we've handled it in onExit.
      // Make this Effect.Effect<void, never> so the caller doesn't need to handle errors.
      Effect.catchAll(() => Effect.void),
    )
  })
}
