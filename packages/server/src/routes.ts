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
 * GOTCHA: Hono creates a new WSContext per event callback. Use ws.raw
 * (the platform socket) as the stable identity key across events.
 */
import { Hono } from 'hono'
import type { UpgradeWebSocket, WSContext } from 'hono/ws'
import type { WyStackApp } from './create'
import { ValidationError } from './validation'

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface RouteOptions {
  app: WyStackApp
  /** URL prefix for all routes. Default: '/api' */
  prefix?: string
  resolveContext?: (req: Request) => Promise<Record<string, unknown>>
}

export function createRoutes(
  opts: RouteOptions,
  upgradeWebSocket: UpgradeWebSocket,
) {
  const { app, prefix = '/api' } = opts
  const resolveContext = opts.resolveContext ?? (async () => ({}))

  const hono = new Hono()

  // --- Subscription tracking ---
  const subToWs = new Map<string, WSContext>()
  // ws.raw (platform socket) → subscription IDs. Needed because Hono
  // creates a new WSContext wrapper per event — can't use === across events.
  const rawToSubIds = new Map<unknown, Set<string>>()
  const rawToContext = new Map<unknown, Record<string, unknown>>()

  function addSub(id: string, ws: WSContext): void {
    subToWs.set(id, ws)
    let ids = rawToSubIds.get(ws.raw)
    if (!ids) {
      ids = new Set()
      rawToSubIds.set(ws.raw, ids)
    }
    ids.add(id)
  }

  function removeSub(id: string, ws: WSContext): void {
    app.subscriptions.remove(id)
    subToWs.delete(id)
    rawToSubIds.get(ws.raw)?.delete(id)
  }

  function removeAllForSocket(ws: WSContext): void {
    const ids = rawToSubIds.get(ws.raw)
    if (!ids) return
    for (const id of ids) {
      app.subscriptions.remove(id)
      subToWs.delete(id)
    }
    rawToSubIds.delete(ws.raw)
    rawToContext.delete(ws.raw)
  }

  // --- WebSocket (registered before /:fn to avoid param catch) ---
  hono.get(
    `${prefix}/ws`,
    async (c, next) => {
      try {
        const context = await resolveContext(c.req.raw)
        c.set('wsContext' as never, context as never)
      } catch (err: unknown) {
        return c.json({ error: errorMessage(err) }, 401)
      }
      return next()
    },
    upgradeWebSocket((c) => {
      return {
        onOpen(_evt, ws) {
          const context = c.get('wsContext' as never) as Record<string, unknown>
          rawToContext.set(ws.raw, context ?? {})
        },

        onMessage(event, ws) {
          const context = rawToContext.get(ws.raw) ?? {}
          let msgId: string | undefined
          try {
            const msg = JSON.parse(String(event.data)) as Record<string, unknown>
            msgId = msg.id as string | undefined

            if (msg.type === 'subscribe') {
              const id = msg.id as string
              const path = msg.path as string
              const args = (msg.args ?? {}) as Record<string, unknown>
              const fn = app.functions.get(path)
              if (!fn || fn.type !== 'query') {
                ws.send(JSON.stringify({ type: 'error', id, error: `Unknown query: ${path}` }))
                return
              }

              app.call(path, args, context).then(({ tablesRead }) => {
                // Guard: socket may have closed while query was in-flight
                if (!rawToContext.has(ws.raw)) return

                app.subscriptions.add({
                  id,
                  functionPath: path,
                  args,
                  context,
                  tablesWatched: tablesRead,
                })
                addSub(id, ws)
                ws.send(JSON.stringify({ type: 'subscribed', id }))
              }).catch((err: unknown) => {
                const payload: Record<string, unknown> = { type: 'error', id, error: errorMessage(err) }
                if (err instanceof ValidationError) payload.issues = err.issues
                ws.send(JSON.stringify(payload))
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
            ws.send(JSON.stringify(payload))
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

    try {
      const argsParam = c.req.query('args')
      const args = argsParam ? JSON.parse(argsParam) : {}
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

    let context: Record<string, unknown>
    try {
      context = await resolveContext(c.req.raw)
    } catch (err: unknown) {
      return c.json({ error: errorMessage(err) }, 401)
    }

    try {
      const body = await c.req.json().catch(() => ({}))
      const callResult = await app.call(functionPath, body, context)

      if (fn.type === 'mutation' && callResult.tablesWritten.size > 0) {
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

async function invalidateSubscriptions(
  app: WyStackApp,
  writtenTables: Set<string>,
  subToWs: Map<string, WSContext>,
) {
  const affected = app.subscriptions.getAffectedSubscriptions(writtenTables)

  await Promise.allSettled(affected.map(async (sub) => {
    const ws = subToWs.get(sub.id)
    if (!ws) return

    // Re-run query to update table dependencies (tables watched may change)
    try {
      const { tablesRead } = await app.call(sub.functionPath, sub.args, sub.context)
      sub.tablesWatched = tablesRead
    } catch {
      // Keep existing table watches — client will see the error on refetch
    }

    ws.send(JSON.stringify({ type: 'invalidate', id: sub.id }))
  }))
}
