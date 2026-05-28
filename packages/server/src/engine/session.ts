// Connection-timescale session.
//
// Session owns all per-connection state: the auth handshake, the authenticated
// gate, subscription lifecycle (pendingSubIds cancellation, subIds teardown),
// and Pipe message routing. It is intentionally decoupled from Hono — the Pipe
// interface is the only transport contract it touches.
//
// Session is attached to a Pipe by `createEngine.attach()`. The caller
// supplies:
//   - `pipe` — the transport channel (loopback, WS adapter, IPC adapter, …)
//   - `upgradeRequest` — the original HTTP upgrade Request, used to build
//     auth requests. For non-HTTP transports (e.g. Electron IPC), pass a
//     synthetic Request with an empty URL.
//   - `resolveContext` — optional; if omitted the session starts authenticated
//     (trusted/no-auth transport; same semantics as routes.ts no-resolveContext path)
//   - `authTimeoutMs` — how long to wait for the auth frame when requiresAuth
//   - `reactive` — if false (or absent), subscribe frames return
//     REACTIVITY_NOT_ENABLED (ADR #12 capability gate)
//
// Race guards (pendingSubIds, post-await authenticated re-check, token commit
// only after winning the concurrent-auth race) are all preserved from the
// original routes.ts implementation.

import type { Pipe } from '@wystack/transport'
import { buildAuthRequest } from './auth-request'
import type { WyStackApp } from '../create'
import { dispatch } from './dispatch'
import { ValidationError } from '../validation'
import type { SubscriptionStore } from './types'

export interface SessionOptions {
  pipe: Pipe
  upgradeRequest: Request
  resolveContext?: (req: Request) => Promise<Record<string, unknown>>
  authTimeoutMs: number
  // Non-null SubscriptionStore enables the reactive tier (ADR #12).
  subscriptions: SubscriptionStore | null
  onSubAdded: (id: string) => void
  onSubRemoved: (id: string) => void
  /**
   * Called after a `call` frame dispatches a mutation with at least one written
   * table. The caller (e.g. the WS routes adapter) uses this to fan-out
   * invalidation frames to affected subscribers, mirroring the HTTP mutation
   * path. If omitted, mutation writes are not invalidated on this Pipe.
   */
  onMutation?: (tablesWritten: Set<string>) => void
  /**
   * Called when the session tears itself down (auth failure, auth timeout,
   * send error). Wire this to the transport's own close event so teardown
   * also fires when the remote end closes the pipe externally — `Pipe` has
   * no built-in onClose hook, so the caller must bridge the gap.
   *
   * Example: in a Hono WS adapter, pass `onClose: detach` in the `onClose`
   * WebSocket callback so subscriptions are removed on client disconnect.
   */
  onClose?: () => void
}

interface SessionState {
  authenticated: boolean
  token: string | null
  context: Record<string, unknown> | null
  timeout: ReturnType<typeof setTimeout> | null
  subIds: Set<string>
  pendingSubIds: Set<string>
  closed: boolean
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createSession(app: WyStackApp, opts: SessionOptions): () => void {
  const { pipe, upgradeRequest, authTimeoutMs } = opts
  const userResolveContext = opts.resolveContext
  const requiresAuth = userResolveContext !== undefined
  const resolveContext = userResolveContext ?? (async () => ({}))

  const state: SessionState = {
    authenticated: !requiresAuth,
    token: null,
    context: null,
    timeout: null,
    subIds: new Set(),
    pendingSubIds: new Set(),
    closed: false,
  }

  function teardown(): void {
    if (state.closed) return
    state.closed = true
    if (state.timeout) {
      clearTimeout(state.timeout)
      state.timeout = null
    }
    for (const id of state.subIds) {
      opts.subscriptions?.remove(id)
      opts.onSubRemoved(id)
    }
    state.subIds.clear()
    state.pendingSubIds.clear()
    opts.onClose?.()
  }

  /** Close the pipe and run teardown so subscriptions are cleaned up. */
  function closeSession(): void {
    teardown()
    pipe.close()
  }

  /** Send a JSON frame, closing the session (not just the pipe) on failure. */
  function safeSend(payload: unknown): void {
    try {
      const result = pipe.send(JSON.stringify(payload))
      if (result instanceof Promise)
        result.catch(() => {
          closeSession()
        })
    } catch {
      /* pipe already closed */
    }
  }

  if (requiresAuth) {
    state.timeout = setTimeout(() => {
      closeSession()
    }, authTimeoutMs)
  }

  async function resolveSubContext(token: string | null): Promise<Record<string, unknown>> {
    const req = buildAuthRequest(upgradeRequest, token)
    return (await resolveContext(req)) ?? {}
  }

  async function handleAuth(msg: Record<string, unknown>): Promise<void> {
    if (state.authenticated) {
      safeSend({ type: 'authenticated' })
      return
    }

    const rawToken = msg.token
    const token = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null

    try {
      const resolvedContext = await resolveSubContext(token)
      if (state.closed) return
      if (state.authenticated) {
        safeSend({ type: 'authenticated' })
        return
      }
      state.token = token
      state.context = resolvedContext
      if (state.timeout) clearTimeout(state.timeout)
      state.timeout = null
      state.authenticated = true
      try {
        const ack = pipe.send(JSON.stringify({ type: 'authenticated' }))
        if (ack instanceof Promise)
          ack.catch(() => {
            closeSession()
          })
      } catch {
        closeSession()
      }
    } catch (err) {
      console.warn('[wystack/server] session auth failed:', errorMessage(err))
      if (!state.closed && !state.authenticated) closeSession()
    }
  }

  async function handleSubscribe(msg: Record<string, unknown>): Promise<void> {
    if (!opts.subscriptions) {
      safeSend({
        type: 'error',
        id: typeof msg.id === 'string' ? msg.id : undefined,
        error: 'REACTIVITY_NOT_ENABLED',
      })
      return
    }

    if (typeof msg.id !== 'string' || typeof msg.path !== 'string') {
      safeSend({
        type: 'error',
        id: typeof msg.id === 'string' ? msg.id : undefined,
        error: 'invalid subscribe message',
      })
      return
    }

    const id = msg.id
    const path = msg.path
    const args = (msg.args ?? {}) as Record<string, unknown>

    // Guard: reject a subscribe whose ID is already owned by another session.
    if (opts.subscriptions?.get(id) && !state.subIds.has(id)) {
      safeSend({ type: 'error', id, error: 'subscription id already in use' })
      return
    }

    const fn = app.functions.get(path)
    if (!fn || fn.type !== 'query') {
      safeSend({ type: 'error', id, error: `Unknown query: ${path}` })
      return
    }

    state.pendingSubIds.add(id)

    let context: Record<string, unknown>
    try {
      context = await resolveSubContext(state.token)
    } catch (err) {
      state.pendingSubIds.delete(id)
      safeSend({ type: 'error', id, error: errorMessage(err) })
      return
    }

    if (!state.pendingSubIds.has(id)) return

    dispatch(app, path, args, context)
      .then(({ tablesRead }) => {
        if (state.closed || !state.pendingSubIds.has(id)) return
        state.pendingSubIds.delete(id)
        opts.subscriptions!.add({
          id,
          functionPath: path,
          args,
          context,
          tablesWatched: tablesRead,
        })
        state.subIds.add(id)
        opts.onSubAdded(id)
        safeSend({ type: 'subscribed', id })
      })
      .catch((err: unknown) => {
        state.pendingSubIds.delete(id)
        const payload: Record<string, unknown> = {
          type: 'error',
          id,
          error: errorMessage(err),
        }
        if (err instanceof ValidationError) payload.issues = err.issues
        safeSend(payload)
      })
  }

  async function handleCall(msg: Record<string, unknown>): Promise<void> {
    if (typeof msg.id !== 'string' || typeof msg.path !== 'string') {
      safeSend({
        type: 'error',
        id: typeof msg.id === 'string' ? msg.id : undefined,
        error: 'invalid call message',
      })
      return
    }
    const callId = msg.id
    const callPath = msg.path
    const callArgs = (msg.args ?? {}) as Record<string, unknown>

    // Re-resolve auth context per call so token revocation is observed,
    // matching the per-subscribe re-resolution in handleSubscribe.
    let context: Record<string, unknown>
    try {
      context = await resolveSubContext(state.token)
    } catch (err) {
      safeSend({ type: 'error', id: callId, error: errorMessage(err) })
      return
    }

    if (state.closed) return

    dispatch(app, callPath, callArgs, context)
      .then(({ result, tablesWritten }) => {
        safeSend({ type: 'result', id: callId, data: result })
        if (tablesWritten.size > 0) opts.onMutation?.(tablesWritten)
      })
      .catch((err: unknown) => {
        const payload: Record<string, unknown> = {
          type: 'error',
          id: callId,
          error: errorMessage(err),
        }
        if (err instanceof ValidationError) payload.issues = err.issues
        safeSend(payload)
      })
  }

  function handleUnsubscribe(msg: Record<string, unknown>): void {
    if (typeof msg.id !== 'string') {
      safeSend({ type: 'error', error: 'invalid unsubscribe message' })
      return
    }
    const subId = msg.id
    // Guard: only cancel/remove subscriptions owned by this session.
    if (!state.subIds.has(subId) && !state.pendingSubIds.has(subId)) {
      safeSend({ type: 'error', id: subId, error: 'unknown subscription id' })
      return
    }
    state.pendingSubIds.delete(subId)
    if (state.subIds.has(subId)) {
      opts.subscriptions?.remove(subId)
      state.subIds.delete(subId)
      opts.onSubRemoved(subId)
    }
  }

  const unsubscribeMessages = pipe.onMessage((raw: unknown) => {
    if (state.closed) return

    let msg: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(String(raw))
      if (
        parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).type === 'string'
      ) {
        msg = parsed as Record<string, unknown>
      }
    } catch {
      /* invalid JSON */
    }

    if (msg === null) {
      if (!state.authenticated) {
        pipe.close()
        return
      }
      safeSend({ type: 'error', error: 'invalid message' })
      return
    }

    if (msg.type === 'auth') {
      void handleAuth(msg)
      return
    }

    if (!state.authenticated) {
      pipe.close()
      return
    }

    if (msg.type === 'subscribe') {
      void handleSubscribe(msg)
      return
    }

    if (msg.type === 'unsubscribe') {
      handleUnsubscribe(msg)
      return
    }

    if (msg.type === 'call') {
      void handleCall(msg)
      return
    }

    // Unknown type post-auth.
    safeSend({
      type: 'error',
      id: typeof msg.id === 'string' ? msg.id : undefined,
      error: `unknown message type: ${String(msg.type)}`,
    })
  })

  return () => {
    unsubscribeMessages()
    teardown()
  }
}
