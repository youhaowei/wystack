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
import type { Pipe } from '@wystack/transport'
import { parseEnvelope } from '@wystack/transport'
import { attachEngine, type AttachEngineOptions } from './engine'
import type { CloseReason } from './engine'
import type { WyStackApp } from './create'
import { ValidationError } from './validation'

// Re-export buildAuthRequest from Session so external consumers that import it
// from routes.ts (e.g. transport.test.ts) still resolve cleanly.
export { buildAuthRequest } from './engine'

/**
 * Per-connection subscription state, keyed by the platform socket (`ws.raw`).
 * Auth and RPC state has moved into the engine's Session (`handle.session`);
 * only the reactive-tier bookkeeping lives here now.
 *
 * `handle`    — the EngineHandle returned by `attachEngine` for this connection.
 * `pipe`      — the Pipe adapter backed by this WS. Inbound frames not handled
 *               by routes.ts (auth, call) are forwarded via `engineInbound`.
 * `engineInbound` — the single inbound handler the engine registered on the
 *               pipe's synthetic `onMessage`. Routes.ts calls it directly for
 *               frames it does not handle (auth, call, malformed, unknown-type),
 *               preserving the engine's protocol policy without a real Pipe.
 * `subIds`    — IDs of active subscriptions on this socket (for cleanup on close).
 * `pendingSubIds` — IDs of in-flight subscribes (see `handleSubscribe`).
 *
 * GOTCHA: Hono creates a new `WSContext` per event callback, so its identity is
 * not stable — the raw socket object is. `Map<object, …>` rather than
 * `Map<unknown, …>` prevents primitive keys from accidentally compiling.
 */
interface Connection {
  handle: ReturnType<typeof attachEngine>
  engineInbound: (message: unknown) => void
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
 */
function safeSend(ws: WSContext, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    /* socket closed */
  }
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
  const resolveContext = opts.resolveContext
  const authTimeoutMs = opts.authTimeoutMs ?? 10_000

  const hono = new Hono()

  // Per-connection reactive-tier state, keyed by the platform socket.
  const rawToConnection = new Map<object, Connection>()
  // sub ID → WSContext, for invalidation dispatch.
  const subToWs = new Map<string, WSContext>()

  // Hono types `ws.raw` as `unknown`; in practice it's always the platform
  // socket object (Bun ServerWebSocket, etc.). Single cast site so if Hono
  // ever tightens the type, there's one place to update.
  const keyOf = (ws: WSContext): object => ws.raw as object

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
    for (const id of conn.subIds) {
      app.subscriptions.remove(id)
      subToWs.delete(id)
    }
    // Drop pending-subscribe IDs so any in-flight resolveContext/.then bails.
    conn.pendingSubIds.clear()
    rawToConnection.delete(keyOf(ws))
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
      context = await conn.handle.session.resolveSubContext()
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
          const rawSocket = keyOf(ws)

          // Build a minimal Pipe wrapping this Hono WS. The engine uses
          // `pipe.send` for outbound frames (authenticated, result, error).
          // `pipe.onMessage` is only used by the engine to register its inbound
          // handler — routes.ts calls that handler directly rather than routing
          // all frames through the Pipe abstraction, so that subscribe/unsubscribe
          // can be intercepted here first (reactive tier stays in routes.ts).
          let engineInbound: ((message: unknown) => void) | null = null
          let pipeClosed = false

          const pipe: Pipe = {
            id: String(rawSocket),
            send(message: unknown): void {
              if (pipeClosed) return
              try {
                ws.send(JSON.stringify(message))
              } catch {
                /* socket closed */
              }
            },
            onMessage(handler: (message: unknown) => void): () => void {
              // The engine calls this exactly once to register its inbound handler.
              engineInbound = handler
              return () => {
                if (engineInbound === handler) engineInbound = null
              }
            },
            close(): void {
              if (pipeClosed) return
              pipeClosed = true
              // ws.close() is idempotent in Hono; call with no code to let the
              // engine's onClose hook set the code first (see mapCloseCode below).
              try {
                ws.close()
              } catch {
                /* already closed */
              }
            },
          }

          /**
           * Map a transport-neutral CloseReason to a WS close code.
           *   auth-failed → 4001 (client does not retry)
           *   transient   → 4002 (client retries with backoff)
           * Called by the engine before it calls pipe.close().
           */
          function mapCloseCode(reason: CloseReason): void {
            const code = reason === 'auth-failed' ? 4001 : 4002
            try {
              ws.close(code, reason)
            } catch {
              /* socket closed */
            }
            pipeClosed = true
          }

          const engineOpts: AttachEngineOptions = {
            app,
            resolveContext,
            authTimeoutMs,
            baseRequest: upgradeRequest,
            onClose: mapCloseCode,
          }

          const handle = attachEngine(pipe, engineOpts)

          rawToConnection.set(rawSocket, {
            handle,
            get engineInbound() {
              return engineInbound as (message: unknown) => void
            },
            subIds: new Set(),
            pendingSubIds: new Set(),
          })
        },

        async onMessage(event, ws) {
          const rawSocket = keyOf(ws)
          const conn = rawToConnection.get(rawSocket)
          if (!conn) {
            // No connection state — engine never ran onOpen for this socket.
            // Rare race; close 4001 (protocol violation).
            ws.close(4001, 'no connection state')
            return
          }

          const raw = String(event.data)

          // Lenient envelope parse to decide routing. If unparseable, forward to
          // the engine (which handles pre/post-auth malformed-frame policy).
          const envelope = parseEnvelope(raw)

          // Reactive-tier frames (subscribe / unsubscribe) are handled here when
          // the connection is authenticated. Everything else — auth, call, unknown
          // type, and ALL pre-auth frames — goes to the engine.
          if (envelope !== null && conn.handle.session.authenticated) {
            if (envelope.type === 'subscribe') {
              await handleSubscribe(envelope as Record<string, unknown>, ws, conn, rawSocket)
              return
            }

            if (envelope.type === 'unsubscribe') {
              if (typeof envelope.id !== 'string') {
                safeSend(ws, { type: 'error', error: 'invalid unsubscribe message' })
                return
              }
              const subId = envelope.id
              // Cancel a pending (in-flight) subscribe before it finishes, so
              // the .then() that registers it sees "not pending" and bails.
              conn.pendingSubIds.delete(subId)
              const sub = app.subscriptions.get(subId)
              if (sub) removeSub(subId, ws)
              return
            }
          }

          // Forward to the engine's inbound handler. The engine owns:
          //   - auth frames (both before and after auth, including idempotent ACK)
          //   - call frames
          //   - malformed / unparseable frames (pre-auth 4001, post-auth error)
          //   - unknown-type frames post-auth (error frame)
          //   - pre-auth non-auth frames (4001)
          const handler = conn.engineInbound
          if (handler) handler(raw)
        },

        onClose(_evt, ws) {
          // Engine teardown: detach cleans up its inbound handler and session.
          const conn = rawToConnection.get(keyOf(ws))
          if (conn) conn.handle.detach()
          // Reactive-tier cleanup: remove all subscriptions for this socket.
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

    const httpResolveContext = resolveContext ?? (async () => ({}))
    let context: Record<string, unknown>
    try {
      context = await httpResolveContext(c.req.raw)
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

    const httpResolveContext = resolveContext ?? (async () => ({}))
    let context: Record<string, unknown>
    try {
      context = await httpResolveContext(c.req.raw)
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
