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
 * success responds `{ type: "authenticated" }`, on failure closes 4001. If no
 * auth frame arrives within `authTimeoutMs`, the socket is closed 4002.
 *
 * GOTCHA: Hono creates a new WSContext per event callback. Use ws.raw
 * (the platform socket) as the stable identity key across events.
 */
import { Hono } from 'hono'
import type { UpgradeWebSocket, WSContext } from 'hono/ws'
import { isSemVer } from '@wystack/types'
import { Version } from '@wystack/version'
import type { WyStackApp } from './create'
import { ValidationError } from './validation'

/**
 * WS wire-protocol version. Distinct from `@wystack/server` package version:
 * bumped only on wire-format changes (new message type, renamed field,
 * close-code semantics).
 *
 * SYNC: keep in lockstep with `WS_PROTOCOL_VERSION` in `@wystack/client`
 * (`packages/client/src/ws.ts`).
 *
 * Pre-1.0 semver rule: any minor bump is breaking.
 */
const WS_PROTOCOL_VERSION = '0.1.0'

function isCompatibleProtocol(clientVersion: string): boolean {
  if (!isSemVer(clientVersion)) return false
  const client = new Version(clientVersion)
  const server = new Version(WS_PROTOCOL_VERSION)
  const d = server.diff(client)
  // Prerelease clients on the same base are accepted — same wire format,
  // experimental tag only. If prerelease ever means "different wire", tighten here.
  if (d === null || d === 'patch' || d === 'prerelease') return true
  if (server.major === 0) return false // pre-1.0: any non-patch diff is breaking
  return d !== 'major'
}

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
  token: string | null
  upgradeRequest: Request
  timeout: ReturnType<typeof setTimeout> | null
  subIds: Set<string>
}

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
  const userResolveContext = opts.resolveContext
  const requiresAuth = userResolveContext !== undefined
  const resolveContext = userResolveContext ?? (async () => ({}))
  const authTimeoutMs = opts.authTimeoutMs ?? 10_000

  const hono = new Hono()

  // Per-connection state (see Connection doc at module scope).
  // NOTE: if a client sends the auth token in the upgrade URL (which AC #1
  // of TASK-489 prohibits), it will be visible to adapters via upgradeRequest.
  // URL-leak prevention depends on the client following the contract.
  const rawToConnection = new Map<object, Connection>()
  // sub ID → WSContext, for invalidation dispatch.
  const subToWs = new Map<string, WSContext>()

  // Hono types `ws.raw` as `unknown`; in practice it's always the platform
  // socket object (Bun ServerWebSocket, etc.). Single cast site so if Hono
  // ever tightens the type, there's one place to update.
  const keyOf = (ws: WSContext): object => ws.raw as object

  function buildAuthRequest(upgradeRequest: Request, token: string | null): Request {
    const headers = new Headers(upgradeRequest.headers)
    if (token !== null && token.length > 0) {
      headers.set('authorization', `Bearer ${token}`)
    }
    return new Request(upgradeRequest.url, {
      method: upgradeRequest.method,
      headers,
    })
  }

  async function resolveSubContext(rawSocket: object): Promise<Record<string, unknown>> {
    const conn = rawToConnection.get(rawSocket)
    if (!conn) throw new Error('connection not registered')
    // Build a fresh Request per call so adapters see a unique identity and
    // don't accumulate mutations across subscriptions on the same connection.
    const req = buildAuthRequest(conn.upgradeRequest, conn.token)
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
    rawToConnection.delete(keyOf(ws))
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
          if (requiresAuth) {
            const timeout = setTimeout(() => {
              ws.close(4002, 'auth timeout')
            }, authTimeoutMs)
            rawToConnection.set(rawSocket, {
              authenticated: false,
              token: null,
              upgradeRequest,
              timeout,
              subIds: new Set(),
            })
          } else {
            rawToConnection.set(rawSocket, {
              authenticated: true,
              token: null,
              upgradeRequest,
              timeout: null,
              subIds: new Set(),
            })
          }
        },

        async onMessage(event, ws) {
          const rawSocket = keyOf(ws)
          const conn = rawToConnection.get(rawSocket)
          if (!conn) {
            ws.close(4001, 'no connection state')
            return
          }

          // Auth handshake guard — before authenticated, only `auth` messages allowed.
          if (!conn.authenticated) {
            let authMsg: Record<string, unknown>
            try {
              authMsg = JSON.parse(String(event.data)) as Record<string, unknown>
            } catch {
              ws.close(4001, 'invalid first message')
              return
            }
            if (authMsg.type !== 'auth') {
              ws.close(4001, 'first message must be auth')
              return
            }
            // Protocol version check. Absent `v` is tolerated and treated as
            // matching server (lets legacy clients speak the current protocol).
            const clientV = typeof authMsg.v === 'string' ? authMsg.v : WS_PROTOCOL_VERSION
            if (!isCompatibleProtocol(clientV)) {
              ws.close(4001, 'incompatible protocol version')
              return
            }
            // Auth frame arrived — stop the "no frame sent" timer. Whatever
            // resolveContext takes is not the 4002 failure mode.
            if (conn.timeout) clearTimeout(conn.timeout)
            conn.timeout = null

            const rawToken = authMsg.token
            const token = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null
            conn.token = token
            try {
              // Race resolveContext against authTimeoutMs so a hung auth
              // backend doesn't leak the socket. The hung promise is not
              // cancellable today (resolveContext has no AbortSignal in v1);
              // it leaks in memory until it settles, but the socket closes.
              await Promise.race([
                resolveSubContext(rawSocket),
                new Promise((_, rej) =>
                  setTimeout(() => rej(new Error('resolveContext timeout')), authTimeoutMs),
                ),
              ])
              // Socket may have closed during the await (disconnect, network).
              if (!rawToConnection.has(rawSocket)) return
              conn.authenticated = true
              try {
                ws.send(JSON.stringify({ type: 'authenticated' }))
              } catch {
                // Can't ack → client will buffer forever. Close so onClose
                // cleanup runs and the client sees a well-defined failure.
                ws.close(4001, 'ack send failed')
              }
            } catch (err) {
              // TODO: replace with @wystack/log once server logging lands.
              console.warn('[wystack/server] resolveContext failed for WS auth:', err)
              conn.token = null
              if (rawToConnection.has(rawSocket)) ws.close(4001, 'auth failed')
            }
            return
          }

          let msgId: string | undefined
          try {
            const msg = JSON.parse(String(event.data)) as Record<string, unknown>
            msgId = msg.id as string | undefined

            // Idempotent auth ACK:
            // - No-auth server, token-configured client → ack so client doesn't hang
            //   waiting for `authenticated`
            // - Auth server, already-authenticated → ignore (avoid double sendSubscriptions
            //   on the client)
            if (msg.type === 'auth') {
              if (!requiresAuth) {
                try {
                  ws.send(JSON.stringify({ type: 'authenticated' }))
                } catch {
                  /* socket closed */
                }
              }
              return
            }

            // TODO: scope subscription IDs per-socket to prevent cross-socket collision
            if (msg.type === 'subscribe') {
              const id = msg.id as string
              const path = msg.path as string
              const args = (msg.args ?? {}) as Record<string, unknown>
              const fn = app.functions.get(path)
              if (!fn || fn.type !== 'query') {
                ws.send(JSON.stringify({ type: 'error', id, error: `Unknown query: ${path}` }))
                return
              }

              // Resolve context PER subscription — Spec Decision:
              // "Context resolved at subscription time, preserved for re-queries"
              const context = await resolveSubContext(rawSocket)

              app
                .call(path, args, context)
                .then(({ tablesRead }) => {
                  // Guard: socket may have closed while query was in-flight
                  if (!rawToConnection.has(rawSocket)) return

                  app.subscriptions.add({
                    id,
                    functionPath: path,
                    args,
                    context,
                    tablesWatched: tablesRead,
                  })
                  addSub(id, ws)
                  try {
                    ws.send(JSON.stringify({ type: 'subscribed', id }))
                  } catch {
                    /* socket closed */
                  }
                })
                .catch((err: unknown) => {
                  const payload: Record<string, unknown> = {
                    type: 'error',
                    id,
                    error: errorMessage(err),
                  }
                  if (err instanceof ValidationError) payload.issues = err.issues
                  try {
                    ws.send(JSON.stringify(payload))
                  } catch {
                    // WebSocket may have closed between error and send
                  }
                })
              return
            }

            if (msg.type === 'unsubscribe') {
              const subId = msg.id as string
              const sub = app.subscriptions.get(subId)
              if (sub) removeSub(subId, ws)
            }
          } catch (err: unknown) {
            const payload: Record<string, unknown> = { type: 'error', error: errorMessage(err) }
            if (err instanceof ValidationError) payload.issues = err.issues
            if (msgId) payload.id = msgId
            try {
              ws.send(JSON.stringify(payload))
            } catch {
              /* socket closed */
            }
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

      try {
        ws.send(JSON.stringify({ type: 'invalidate', id: sub.id }))
      } catch {
        /* socket closed */
      }
    }),
  )
}
