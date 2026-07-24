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
 *   4002 — transient: handshake timed out within `authTimeoutMs`, the server
 *          failed to send the `authenticated` ack, or the identity provider
 *          could not be consulted (client retries with backoff)
 *
 * The last case is why `resolveContext` throwing is not uniformly 4001: a key
 * endpoint that is down is our dependency failing, not the client's credential
 * being bad, and 4001 would tell every connected client to stop retrying for the
 * duration of an outage that resolves on its own. The same split applies to the
 * HTTP handlers below, which answer 503 rather than 401. See
 * `IdentityProviderUnavailableError` in `@wystack/identity`.
 *
 * GOTCHA: Hono creates a new WSContext per event callback. Use ws.raw
 * (the platform socket) as the stable identity key across events.
 */
import { isIdentityProviderUnavailable } from '@wystack/identity'
import { Hono } from 'hono'
import type { UpgradeWebSocket, WSContext } from 'hono/ws'
import type { Pipe } from '@wystack/transport'
import { PermissionDeniedError } from '@wystack/permissions'
import {
  attachEngine,
  type AttachEngineOptions,
  createInMemorySubscriptionStore,
  createInvalidationRouter,
} from './engine'
import type { CloseReason } from './engine'
import type { WyStackApp } from './create'
import { ValidationError } from './validation'
import { AuthenticationRequiredError } from './functions'

// Re-export buildAuthRequest from Session so external consumers that import it
// from routes.ts (e.g. transport.test.ts) still resolve cleanly.
export { buildAuthRequest } from './engine'

/**
 * Per-connection state, keyed by the platform socket (`ws.raw`).
 *
 * `handle`       — the EngineHandle returned by `attachEngine` for this
 *                  connection.
 * `engineInbound`— the single inbound handler the engine registered on the
 *                  Pipe's `onMessage`. Routes.ts calls it directly for all
 *                  inbound WS frames. A getter so the connection always sees
 *                  the engine's current handler — `null` after detach.
 *
 * GOTCHA: Hono creates a new `WSContext` per event callback, so its identity is
 * not stable — the raw socket object is. `Map<object, …>` rather than
 * `Map<unknown, …>` prevents primitive keys from accidentally compiling.
 */
interface Connection {
  handle: ReturnType<typeof attachEngine>
  engineInbound: ((message: unknown) => void) | null
}

// Monotonic source for per-connection Pipe ids. `ws.raw` is a stable identity
// key but stringifies to "[object Object]", so it cannot serve as the Pipe
// contract's "stable per-connection identifier for diagnostics and correlation."
let nextConnectionId = 0

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
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

  // --- Shared reactive tier: one store per server instance, the app's source ---
  //
  // A single SubscriptionStore holds all live subscriptions across every
  // connection. The write-event stream is the APP's one `invalidationSource`
  // (create.ts) — this transport does NOT mint its own, so a write on any surface
  // sharing this app instance (REST caller, WS call-frame) reaches these
  // subscriptions. Two sources would resurrect the split this collapse removes.
  //
  // ONE InvalidationRouter is registered here (not per-connection) to avoid
  // the double-fan trap: if each attachEngine registered its own onInvalidation
  // handler, N connections would produce N invalidate frames per affected sub.
  //
  // The router does the re-query using entry.context (subscription-time context)
  // — it never calls resolveContext again. entry.send is the post-close-safe
  // closure the engine built at subscribe time.
  const subscriptionStore = createInMemorySubscriptionStore()

  createInvalidationRouter({
    source: app.invalidationSource,
    store: subscriptionStore,
    recompute: async (entry) => {
      const { tablesRead } = await app.call(entry.functionPath, entry.args, entry.context)
      return { tablesRead }
    },
  })

  // Per-connection state, keyed by the platform socket.
  const rawToConnection = new Map<object, Connection>()

  // Hono types `ws.raw` as `unknown`; in practice it's always the platform
  // socket object (Bun ServerWebSocket, etc.). Single cast site so if Hono
  // ever tightens the type, there's one place to update.
  const keyOf = (ws: WSContext): object => ws.raw as object

  // --- WebSocket (registered before /:fn to avoid param catch) ---
  hono.get(
    `${prefix}/ws`,
    upgradeWebSocket((c) => {
      // Capture the original HTTP upgrade Request (cookies, headers, URL).
      const upgradeRequest = c.req.raw

      return {
        onOpen(_evt, ws) {
          const rawSocket = keyOf(ws)

          // Build a minimal Pipe wrapping this Hono WS. The engine handles all
          // frame types (auth, call, subscribe, unsubscribe) — routes.ts no longer
          // intercepts subscribe/unsubscribe before forwarding to the engine.
          let engineInbound: ((message: unknown) => void) | null = null
          let pipeClosed = false

          const pipe: Pipe = {
            id: `ws-${++nextConnectionId}`,
            send(message: unknown): void {
              // Post-close: silent no-op, per the Pipe contract. While the
              // socket is live a `ws.send` throw is a real transport failure —
              // it MUST propagate. The engine swallows it for fire-and-forget
              // frames via its own `send` helper, but `await`s this directly for
              // the committing `authenticated` ack so it can close `transient`
              // (4002) on failure rather than strand the client on its ack timer.
              if (pipeClosed) return
              ws.send(JSON.stringify(message))
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
            subscriptionStore,
          }

          const handle = attachEngine(pipe, engineOpts)

          rawToConnection.set(rawSocket, {
            handle,
            // A getter so the connection always sees the engine's current
            // handler — `null` after detach, a function while attached. The
            // call site in `onMessage` null-checks before invoking.
            get engineInbound() {
              return engineInbound
            },
          })
        },

        onMessage(event, ws) {
          const rawSocket = keyOf(ws)
          const conn = rawToConnection.get(rawSocket)
          if (!conn) {
            // No connection state — engine never ran onOpen for this socket.
            // Rare race; close 4001 (protocol violation).
            ws.close(4001, 'no connection state')
            return
          }

          // Forward all frames to the engine's inbound handler. The engine now
          // owns auth, call, subscribe, unsubscribe, malformed-frame policy, and
          // the reactive tier (when a subscriptionStore is wired; emission is the
          // app's job via app.call → app.invalidationSource).
          const handler = conn.engineInbound
          if (handler) handler(String(event.data))
        },

        onClose(_evt, ws) {
          // Engine teardown: detach cleans up its inbound handler, session,
          // and all reactive subscriptions registered by this connection.
          const conn = rawToConnection.get(keyOf(ws))
          if (conn) {
            conn.handle.detach()
            rawToConnection.delete(keyOf(ws))
          }
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
      // An unreachable identity provider is a dependency failure, not a rejected
      // credential. Answering 401 would blame the user's token for an upstream outage
      // and, on the WebSocket path, tell clients not to retry.
      if (isIdentityProviderUnavailable(err)) {
        return c.json({ error: 'identity provider unavailable' }, 503)
      }
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
      if (err instanceof PermissionDeniedError) {
        return c.json({ error: err.message }, 403)
      }
      if (err instanceof AuthenticationRequiredError) {
        // Not signed in is a 401, not a server fault. Left untyped it fell through to
        // the generic branch below and answered 500, which reads as "the server broke"
        // and hides an ordinary sign-in prompt inside the error budget.
        return c.json({ error: err.message }, 401)
      }
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
      // An unreachable identity provider is a dependency failure, not a rejected
      // credential. Answering 401 would blame the user's token for an upstream outage
      // and, on the WebSocket path, tell clients not to retry.
      if (isIdentityProviderUnavailable(err)) {
        return c.json({ error: 'identity provider unavailable' }, 503)
      }
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
      // No emit here: `app.call` fuses invalidation on the app's source
      // (create.ts), and the router above is wired to that same source.
      return c.json({ data: callResult.result })
    } catch (err: unknown) {
      if (err instanceof PermissionDeniedError) {
        return c.json({ error: err.message }, 403)
      }
      if (err instanceof AuthenticationRequiredError) {
        // Not signed in is a 401, not a server fault. Left untyped it fell through to
        // the generic branch below and answered 500, which reads as "the server broke"
        // and hides an ordinary sign-in prompt inside the error budget.
        return c.json({ error: err.message }, 401)
      }
      if (err instanceof ValidationError) {
        return c.json({ error: err.message, issues: err.issues }, 400)
      }
      return c.json({ error: errorMessage(err) }, 500)
    }
  })

  return hono
}
