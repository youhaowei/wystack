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
import { Version } from '@wystack/version'
import type { WyStackApp } from './create'
import { ValidationError } from './validation'

/**
 * WS wire-protocol version. Distinct from `@wystack/server` package version:
 * bumped only on wire-format changes (new message type, renamed field,
 * close-code semantics). Kept in sync with `@wystack/client`'s
 * `WS_PROTOCOL_VERSION` constant.
 *
 * Pre-1.0 semver rule: any minor bump is breaking.
 */
const WS_PROTOCOL_VERSION = '0.1.0'

function isCompatibleProtocol(clientVersion: string): boolean {
  let client: Version
  let server: Version
  try {
    client = new Version(clientVersion)
    server = new Version(WS_PROTOCOL_VERSION)
  } catch {
    return false
  }
  const d = server.diff(client)
  if (d === null || d === 'patch' || d === 'prerelease') return true
  if (server.major === 0) return false // pre-1.0: any non-patch diff is breaking
  return d !== 'major'
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

  // --- Per-connection state ---
  //
  // `rawToConnection` is the single source of truth per WebSocket. Keyed by
  // `ws.raw` (the platform socket) because Hono creates a new WSContext per
  // event callback — WSContext identity is not stable across events.
  //
  // `upgradeRequest` is the original HTTP upgrade Request — the one-time
  // chance to capture cookies, forwarded headers, URL, origin. The client
  // token from the auth frame is stored separately and layered on top via
  // `resolveSubContext` (Authorization: Bearer). Adapters (e.g., BetterAuth)
  // see cookies AND Bearer together.
  //
  // NOTE: if a client sends the auth token in the upgrade URL (which AC #1 of
  // TASK-489 prohibits), it will be visible to adapters. URL-leak prevention
  // depends on the client following the contract.
  interface Connection {
    authenticated: boolean
    token: string | null
    upgradeRequest: Request
    timeout: ReturnType<typeof setTimeout> | null
    subIds: Set<string>
  }
  const rawToConnection = new Map<unknown, Connection>()
  // sub ID → WSContext, for invalidation dispatch.
  const subToWs = new Map<string, WSContext>()

  async function resolveSubContext(rawSocket: unknown): Promise<Record<string, unknown>> {
    const conn = rawToConnection.get(rawSocket)
    if (!conn) throw new Error('connection not registered')
    const headers = new Headers(conn.upgradeRequest.headers)
    if (conn.token !== null && conn.token.length > 0) {
      headers.set('authorization', `Bearer ${conn.token}`)
    }
    const req = new Request(conn.upgradeRequest.url, {
      method: conn.upgradeRequest.method,
      headers,
    })
    const context = await resolveContext(req)
    return context ?? {}
  }

  function addSub(id: string, ws: WSContext): void {
    subToWs.set(id, ws)
    const conn = rawToConnection.get(ws.raw)
    if (conn) conn.subIds.add(id)
  }

  function removeSub(id: string, ws: WSContext): void {
    app.subscriptions.remove(id)
    subToWs.delete(id)
    rawToConnection.get(ws.raw)?.subIds.delete(id)
  }

  function removeAllForSocket(ws: WSContext): void {
    const conn = rawToConnection.get(ws.raw)
    if (!conn) return
    if (conn.timeout) clearTimeout(conn.timeout)
    for (const id of conn.subIds) {
      app.subscriptions.remove(id)
      subToWs.delete(id)
    }
    rawToConnection.delete(ws.raw)
  }

  // --- WebSocket (registered before /:fn to avoid param catch) ---
  hono.get(
    `${prefix}/ws`,
    upgradeWebSocket((c) => {
      // Capture the original HTTP upgrade Request (cookies, headers, URL).
      const upgradeRequest = c.req.raw
      return {
        onOpen(_evt, ws) {
          if (requiresAuth) {
            const timeout = setTimeout(() => {
              ws.close(4002, 'auth timeout')
            }, authTimeoutMs)
            rawToConnection.set(ws.raw, {
              authenticated: false,
              token: null,
              upgradeRequest,
              timeout,
              subIds: new Set(),
            })
          } else {
            rawToConnection.set(ws.raw, {
              authenticated: true,
              token: null,
              upgradeRequest,
              timeout: null,
              subIds: new Set(),
            })
          }
        },

        async onMessage(event, ws) {
          const conn = rawToConnection.get(ws.raw)
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

            // Validate the token by running resolveContext through resolveSubContext,
            // then store the token so each subscribe re-resolves (per-sub context).
            const rawToken = authMsg.token
            const token = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null
            conn.token = token
            try {
              await resolveSubContext(ws.raw)
              // Socket may have closed during the await (disconnect, network).
              if (!rawToConnection.has(ws.raw)) return
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
              if (rawToConnection.has(ws.raw)) ws.close(4001, 'auth failed')
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
              const context = await resolveSubContext(ws.raw)

              app
                .call(path, args, context)
                .then(({ tablesRead }) => {
                  // Guard: socket may have closed while query was in-flight
                  if (!rawToConnection.has(ws.raw)) return

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
