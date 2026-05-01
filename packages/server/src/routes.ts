/**
 * Hono route definitions for WyStack transport.
 *
 * Routes (default prefix /api):
 *   GET  /api/:fn?args=...  — queries (cacheable, SSR-friendly)
 *   POST /api/:fn           — mutations (JSON body)
 *   WS   /api/ws            — subscribe/unsubscribe/invalidation
 *
 * Runtime-agnostic: each entrypoint (serve-bun, serve-node) provides its own
 * `upgradeWebSocket` adapter. The shared protocol is identical.
 *
 * WS auth: when `resolveContext` is configured, the client must send
 * `{ type: "auth", token }` as the first frame. Server calls `resolveContext`
 * with a synthetic Request carrying `Authorization: Bearer ${token}`; on
 * success responds `{ type: "authenticated" }`, on failure closes 4001.
 *
 * No-auth servers (`resolveContext` omitted) start the connection authenticated:
 * subscribe/unsubscribe frames can be the first message. If a legacy or
 * token-configured client sends `auth` anyway, the server sends a structural ACK
 * but does not resolve, store, or trust that token.
 *
 * If the client sends `token: null` (anonymous), any Authorization header
 * that leaked into the upgrade request (cookie proxy, reverse proxy, stale
 * query) is stripped before `resolveContext` runs — the WS auth frame is
 * the sole identity source for the connection. Adapters can rely on this.
 *
 * Close codes:
 *   4001 — auth failed / missing / protocol violation (client does not retry)
 *   4002 — transient: handshake timed out within `authTimeoutMs`, or server
 *          failed to send the `authenticated` ack (client retries with backoff)
 *
 * GOTCHA: Hono creates a new WSContext per event callback. Use ws.raw
 * (the platform socket) as the stable identity key across events.
 */
import { Hono } from 'hono'
import type { UpgradeWebSocket, WSContext } from 'hono/ws'
import type { WyStackApp } from './create'
import { ValidationError } from './validation'

/**
 * Per-connection state, keyed by the platform socket (`ws.raw`). Hono creates
 * a new `WSContext` per event callback, so its identity is not stable — the
 * raw socket object is. Map<object, …> (rather than Map<unknown, …>) prevents
 * primitive keys from accidentally compiling.
 *
 * `upgradeRequest` is the original HTTP upgrade Request — captured once so
 * `resolveContext` can see cookies, forwarded headers, URL, and origin. A
 * fresh `Request` with the Bearer header layered on is built per subscribe
 * (see `resolveSubContext`) so adapters get a unique Request per call, avoiding
 * shared-mutation and identity-keyed deduplication hazards.
 */
interface Connection {
  authenticated: boolean
  /**
   * Captured once from the client's auth frame and reused by every subsequent
   * `resolveSubContext` call for the lifetime of this connection. If the JWT
   * expires mid-session, new subscriptions present the stale token to
   * `resolveContext` and fail; the client must reconnect to supply a fresh
   * one. The `getToken` callback is invoked per-connect, so
   * disconnect()+connect() on the client is the supported rotation path.
   */
  token: string | null
  upgradeRequest: Request
  timeout: ReturnType<typeof setTimeout> | null
  subIds: Set<string>
  /**
   * Subscribe IDs whose `resolveContext` / `app.call` is in-flight. Lets an
   * `unsubscribe` arriving mid-await cancel the pending registration so the
   * resolved subscription doesn't orphan itself in `app.subscriptions`.
   *
   * known-debt: this is flag-check cancellation, not signal-plumbing. The
   * adapter's `resolveContext` keeps running to completion even after
   * cancellation — we bail at the `.then` boundary. Wasted work for expensive
   * adapters (external auth service, DB session lookup). Upgrading to
   * `AbortSignal` on the `Request` passed to `resolveContext` would let
   * adapters opt into cancellation. Deferred until an adapter proposal makes
   * the cost measurable. Search: `kb search "AbortSignal resolveContext"`.
   */
  pendingSubIds: Set<string>
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Send JSON over a WS, swallowing the post-close throw. Outbound frames
 * race against unrelated closes; collapsing the try/catch at the call
 * site keeps handler logic linear.
 *
 * One outbound frame deliberately does NOT use this helper: the
 * `authenticated` ack in `handleAuthFrame` uses raw `ws.send` so it can
 * catch the post-close throw and close 4002 (transient — auth succeeded
 * but transport died). Using `safeSend` there would silently drop the
 * ack and leave the client stuck waiting on its ack timer.
 */
function safeSend(ws: WSContext, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    /* socket closed */
  }
}

/**
 * Build the synthetic `Request` passed to `resolveContext` for a WS subscribe.
 *
 * When `token` is a non-empty string, layers `Authorization: Bearer ${token}`
 * over the upgrade request's headers. When `token` is `null` (anonymous),
 * strips any inherited Authorization header so the WS auth frame is the sole
 * identity source — prevents a null-token client from silently inheriting an
 * identity that leaked into the upgrade via cookie proxy, reverse proxy, or
 * stale query handoff. Exported for direct unit testing of this invariant.
 */
export function buildAuthRequest(upgradeRequest: Request, token: string | null): Request {
  const headers = new Headers(upgradeRequest.headers)
  if (token !== null && token.length > 0) {
    headers.set('authorization', `Bearer ${token}`)
  } else {
    headers.delete('authorization')
  }
  return new Request(upgradeRequest.url, {
    method: upgradeRequest.method,
    headers,
  })
}

/**
 * Parse a client WS frame as a plain object. Rejects non-object JSON
 * (`null`, arrays, primitives) and non-string `type` up front so downstream
 * dispatch never faces a TypeError from `msg.type` on a null body or routes
 * on a numeric `type`. Returns null for any invalid shape — caller picks
 * the close code (pre-auth 4001 vs post-auth error frame).
 */
function parseClientMessage(data: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const msg = parsed as Record<string, unknown>
  if (typeof msg.type !== 'string') return null
  return msg
}

export interface RouteOptions {
  app: WyStackApp
  /** URL prefix for all routes. Default: '/api' */
  prefix?: string
  resolveContext?: (req: Request) => Promise<Record<string, unknown>>
  /**
   * Max ms to wait for the WS auth handshake message after connect.
   * Only applies when `resolveContext` is configured. Default: 10_000.
   */
  authTimeoutMs?: number
}

export function createRoutes(opts: RouteOptions, upgradeWebSocket: UpgradeWebSocket) {
  const { app, prefix = '/api' } = opts
  const userResolveContext = opts.resolveContext
  const requiresAuth = userResolveContext !== undefined
  const resolveContext = userResolveContext ?? (async () => ({}))
  const authTimeoutMs = opts.authTimeoutMs ?? 10_000

  const hono = new Hono()

  // Per-connection state (see Connection doc at module scope).
  // URL-leak prevention is a client-side contract: the WyStack client never
  // appends `?token=...` to the WS URL. If a custom client does, the server
  // can't redact it from upgradeRequest — adapters will see it. Server-side
  // enforcement would require parsing every upgrade URL and is out of scope.
  const rawToConnection = new Map<object, Connection>()
  // sub ID → WSContext, for invalidation dispatch.
  const subToWs = new Map<string, WSContext>()

  // Hono types `ws.raw` as `unknown`; in practice it's always the platform
  // socket object (Bun ServerWebSocket, etc.). Single cast site so if Hono
  // ever tightens the type, there's one place to update.
  const keyOf = (ws: WSContext): object => ws.raw as object

  async function resolveSubContext(
    rawSocket: object,
    token: string | null,
  ): Promise<Record<string, unknown>> {
    const conn = rawToConnection.get(rawSocket)
    if (!conn) throw new Error('connection not registered')
    // Build a fresh Request per call so adapters see a unique identity and
    // don't accumulate mutations across subscriptions on the same connection.
    const req = buildAuthRequest(conn.upgradeRequest, token)
    return (await resolveContext(req)) ?? {}
  }

  function addSub(id: string, ws: WSContext): void {
    subToWs.set(id, ws)
    const conn = rawToConnection.get(keyOf(ws))
    if (conn) conn.subIds.add(id)
  }

  function removeSub(id: string, ws: WSContext): void {
    app.subscriptions.remove(id)
    subToWs.delete(id)
    rawToConnection.get(keyOf(ws))?.subIds.delete(id)
  }

  function removeAllForSocket(ws: WSContext): void {
    const conn = rawToConnection.get(keyOf(ws))
    if (!conn) return
    if (conn.timeout) clearTimeout(conn.timeout)
    for (const id of conn.subIds) {
      app.subscriptions.remove(id)
      subToWs.delete(id)
    }
    // Drop pending-subscribe IDs so any in-flight resolveContext/.then bails.
    conn.pendingSubIds.clear()
    rawToConnection.delete(keyOf(ws))
  }

  /**
   * Handle an inbound `{type:"auth", token}` frame. Two paths:
   *
   *   1. Unauthenticated → run resolveContext, then ACK or close 4001.
   *      The onOpen 4002 timer is still running; a hung resolveContext
   *      trips it, closing the socket (resolveContext completes into a
   *      dead socket — harmless).
   *   2. Already authenticated (no-auth server OR repeat frame) →
   *      idempotent ACK so a token-configured client does not hang. This path
   *      never adopts the token; no-auth transports rely on connection trust,
   *      not WS credentials.
   */
  async function handleAuthFrame(
    msg: Record<string, unknown>,
    ws: WSContext,
    conn: Connection,
    rawSocket: object,
  ): Promise<void> {
    if (conn.authenticated) {
      safeSend(ws, { type: 'authenticated' })
      return
    }

    const rawToken = msg.token
    // Parse the token locally — do NOT write conn.token yet. Two concurrent
    // auth frames can both pass the pre-await authenticated===false check.
    // Writing conn.token here would let the slower frame overwrite the faster
    // frame's token before resolveSubContext reads it, causing the winning
    // frame to authenticate under a different identity. Commit only after
    // confirming we won the race below.
    const token = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null

    try {
      await resolveSubContext(rawSocket, token)
      if (!rawToConnection.has(rawSocket)) return
      // Re-check after await: Bun dispatches onMessage without awaiting the
      // previous handler, so two rapid auth frames can both pass the pre-await
      // guard. The slower frame finds conn.authenticated already true and sends
      // an idempotent ACK — it must NOT overwrite conn.token (that would swap
      // the winning identity's token under live subscriptions).
      if (conn.authenticated) {
        safeSend(ws, { type: 'authenticated' })
        return
      }
      // Won the race — commit token and mark authenticated.
      conn.token = token
      if (conn.timeout) clearTimeout(conn.timeout)
      conn.timeout = null
      conn.authenticated = true
      try {
        ws.send(JSON.stringify({ type: 'authenticated' }))
      } catch {
        // Auth succeeded but the transport died before we could ack. This is
        // a network flake, not an auth failure — close 4002 so the client
        // retries with backoff rather than latching authFailed and giving up.
        ws.close(4002, 'ack send failed')
      }
    } catch (err) {
      // TODO: replace with @wystack/log once server logging lands.
      // Log message only — not the full error — to avoid leaking token/header
      // values that resolveContext implementations may embed in thrown errors.
      console.warn('[wystack/server] WS auth failed:', errorMessage(err))
      // Guard conn.authenticated: if the concurrent winning frame already
      // succeeded, don't tear down an authenticated connection with 4001.
      if (rawToConnection.has(rawSocket) && !conn.authenticated) ws.close(4001, 'auth failed')
    }
  }

  /**
   * Handle an inbound `{type:"subscribe", id, path, args}` frame. Uses
   * `conn.pendingSubIds` so an `unsubscribe` arriving during the
   * `resolveContext` await cleanly cancels the registration, rather than
   * orphaning the sub in `app.subscriptions`. A hung adapter has no timer
   * here — cancellation arrives via client unsubscribe or socket close
   * (both drop the id from `pendingSubIds` and the `.then` bails).
   */
  async function handleSubscribe(
    msg: Record<string, unknown>,
    ws: WSContext,
    conn: Connection,
    rawSocket: object,
  ): Promise<void> {
    // Runtime narrowing: `id` is used as a Map key and `path` as a function
    // registry lookup. Non-string values (object, number) would bypass
    // `pendingSubIds` reference-identity guards and silently orphan the sub.
    if (typeof msg.id !== 'string' || typeof msg.path !== 'string') {
      safeSend(ws, {
        type: 'error',
        id: typeof msg.id === 'string' ? msg.id : undefined,
        error: 'invalid subscribe message',
      })
      return
    }
    const id = msg.id
    const path = msg.path
    const args = (msg.args ?? {}) as Record<string, unknown>
    const fn = app.functions.get(path)
    if (!fn || fn.type !== 'query') {
      safeSend(ws, { type: 'error', id, error: `Unknown query: ${path}` })
      return
    }

    conn.pendingSubIds.add(id)

    // Resolve context PER subscription — Spec Decision:
    // "Context resolved at subscription time, preserved for re-queries"
    let context: Record<string, unknown>
    try {
      context = await resolveSubContext(rawSocket, conn.token)
    } catch (err) {
      conn.pendingSubIds.delete(id)
      safeSend(ws, { type: 'error', id, error: errorMessage(err) })
      return
    }

    // Unsubscribe may have arrived during the await — it dropped `id` from
    // pendingSubIds. Bail before running the query.
    if (!conn.pendingSubIds.has(id)) return

    app
      .call(path, args, context)
      .then(({ tablesRead }) => {
        // Guard: socket closed, OR unsubscribe arrived during the query.
        if (!rawToConnection.has(rawSocket) || !conn.pendingSubIds.has(id)) return
        conn.pendingSubIds.delete(id)
        app.subscriptions.add({
          id,
          functionPath: path,
          args,
          context,
          tablesWatched: tablesRead,
        })
        addSub(id, ws)
        safeSend(ws, { type: 'subscribed', id })
      })
      .catch((err: unknown) => {
        conn.pendingSubIds.delete(id)
        const payload: Record<string, unknown> = {
          type: 'error',
          id,
          error: errorMessage(err),
        }
        if (err instanceof ValidationError) payload.issues = err.issues
        safeSend(ws, payload)
      })
  }

  // --- WebSocket (registered before /:fn to avoid param catch) ---
  hono.get(
    `${prefix}/ws`,
    upgradeWebSocket((c) => {
      // Capture the original HTTP upgrade Request (cookies, headers, URL).
      const upgradeRequest = c.req.raw
      return {
        onOpen(_evt, ws) {
          const timeout = requiresAuth
            ? setTimeout(() => ws.close(4002, 'auth timeout'), authTimeoutMs)
            : null
          rawToConnection.set(keyOf(ws), {
            authenticated: !requiresAuth,
            token: null,
            upgradeRequest,
            timeout,
            subIds: new Set(),
            pendingSubIds: new Set(),
          })
        },

        async onMessage(event, ws) {
          const rawSocket = keyOf(ws)
          const conn = rawToConnection.get(rawSocket)
          if (!conn) {
            ws.close(4001, 'no connection state')
            return
          }

          const msg = parseClientMessage(String(event.data))
          if (msg === null) {
            // Invalid shape: unparseable JSON, `null`, array, primitive, or
            // non-string `type`. Pre-auth a malformed first frame is a
            // protocol violation (close 4001 — AC #2 / PRD edge case).
            // Post-auth send an error frame and stay open.
            if (!conn.authenticated) {
              ws.close(4001, 'invalid first message')
              return
            }
            safeSend(ws, { type: 'error', error: 'invalid message' })
            return
          }

          // `auth` is the only message type allowed to cross the unauth boundary.
          // Auth-required servers run the full handshake; no-auth servers reply
          // with a compatibility ACK and ignore any supplied token.
          if (msg.type === 'auth') {
            await handleAuthFrame(msg, ws, conn, rawSocket)
            return
          }

          if (!conn.authenticated) {
            ws.close(4001, 'first message must be auth')
            return
          }

          let msgId: string | undefined
          try {
            msgId = msg.id as string | undefined

            // Filed: TASK-490 — scope subscription IDs per-socket to prevent cross-socket collision
            if (msg.type === 'subscribe') {
              await handleSubscribe(msg, ws, conn, rawSocket)
              return
            }

            if (msg.type === 'unsubscribe') {
              if (typeof msg.id !== 'string') {
                safeSend(ws, { type: 'error', error: 'invalid unsubscribe message' })
                return
              }
              const subId = msg.id
              // Cancel a pending (in-flight) subscribe before it finishes, so
              // the .then() that registers it sees "not pending" and bails.
              conn.pendingSubIds.delete(subId)
              const sub = app.subscriptions.get(subId)
              if (sub) removeSub(subId, ws)
              return
            }

            // Unknown type post-auth. Help devs during protocol evolution.
            safeSend(ws, {
              type: 'error',
              id: typeof msg.id === 'string' ? msg.id : undefined,
              error: `unknown message type: ${String(msg.type)}`,
            })
          } catch (err: unknown) {
            const payload: Record<string, unknown> = { type: 'error', error: errorMessage(err) }
            if (err instanceof ValidationError) payload.issues = err.issues
            if (msgId) payload.id = msgId
            safeSend(ws, payload)
          }
        },

        onClose(_evt, ws) {
          removeAllForSocket(ws)
        },
      }
    }),
  )

  // --- HTTP: queries (GET) ---
  hono.get(`${prefix}/:fn`, async (c) => {
    const functionPath = c.req.param('fn')
    const fn = app.functions.get(functionPath)

    if (!fn) {
      return c.json({ error: `Unknown function: ${functionPath}` }, 404)
    }

    if (fn.type !== 'query') {
      return c.json({ error: `${functionPath} is a mutation — use POST` }, 405)
    }

    let context: Record<string, unknown>
    try {
      context = await resolveContext(c.req.raw)
    } catch (err: unknown) {
      return c.json({ error: errorMessage(err) }, 401)
    }

    const argsParam = c.req.query('args')
    let args: unknown = {}
    if (argsParam) {
      try {
        args = JSON.parse(argsParam)
      } catch {
        return c.json({ error: 'Invalid JSON in args parameter' }, 400)
      }
    }

    try {
      const { result } = await app.call(functionPath, args, context)
      return c.json({ data: result })
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        return c.json({ error: err.message, issues: err.issues }, 400)
      }
      return c.json({ error: errorMessage(err) }, 500)
    }
  })

  // --- HTTP: mutations (POST) ---
  hono.post(`${prefix}/:fn`, async (c) => {
    const functionPath = c.req.param('fn')
    const fn = app.functions.get(functionPath)

    if (!fn) {
      return c.json({ error: `Unknown function: ${functionPath}` }, 404)
    }

    if (fn.type !== 'mutation') {
      return c.json({ error: `${functionPath} is a query — use GET` }, 405)
    }

    let context: Record<string, unknown>
    try {
      context = await resolveContext(c.req.raw)
    } catch (err: unknown) {
      return c.json({ error: errorMessage(err) }, 401)
    }

    let body: unknown = {}
    const rawText = await c.req.text()
    if (rawText.trim()) {
      try {
        body = JSON.parse(rawText)
      } catch {
        return c.json({ error: 'Invalid JSON in request body' }, 400)
      }
    }

    try {
      const callResult = await app.call(functionPath, body, context)

      if (callResult.tablesWritten.size > 0) {
        await invalidateSubscriptions(app, callResult.tablesWritten, subToWs)
      }

      return c.json({ data: callResult.result })
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        return c.json({ error: err.message, issues: err.issues }, 400)
      }
      return c.json({ error: errorMessage(err) }, 500)
    }
  })

  return hono
}

// TODO: serialize invalidation per-subscription to prevent tablesWatched race under concurrent mutations
async function invalidateSubscriptions(
  app: WyStackApp,
  writtenTables: Set<string>,
  subToWs: Map<string, WSContext>,
) {
  const affected = app.subscriptions.getAffectedSubscriptions(writtenTables)

  await Promise.allSettled(
    affected.map(async (sub) => {
      const ws = subToWs.get(sub.id)
      if (!ws) return

      // Re-run query to update table dependencies (tables watched may change)
      try {
        const { tablesRead } = await app.call(sub.functionPath, sub.args, sub.context)
        sub.tablesWatched = tablesRead
      } catch {
        // Keep existing table watches — client will see the error on refetch
      }

      safeSend(ws, { type: 'invalidate', id: sub.id })
    }),
  )
}
