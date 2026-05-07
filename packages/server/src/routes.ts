/**
 * Hono route definitions for WyStack transport.
 *
 * Routes (default prefix /api):
 *   GET  /api/:fn?args=...  - queries (cacheable, SSR-friendly)
 *   POST /api/:fn           - mutations (JSON body)
 *   WS   /api/ws            - subscribe/unsubscribe/invalidation
 *
 * Runtime-agnostic: each entrypoint provides its own `upgradeWebSocket`
 * adapter. The shared protocol is identical.
 */
import { Hono } from 'hono'
import type { UpgradeWebSocket, WSContext } from 'hono/ws'
import { ValidationError } from './validation'
import { errorMessage, buildAuthRequest } from './routes/helpers'
import { invalidateSubscriptions } from './routes/subscriptions'
import type { RouteOptions } from './routes/types'
import { createWebSocketRoute } from './routes/ws'

export type { RouteOptions } from './routes/types'
export { buildAuthRequest }

export function createRoutes(opts: RouteOptions, upgradeWebSocket: UpgradeWebSocket) {
  const { app, prefix = '/api' } = opts
  const userResolveContext = opts.resolveContext
  const requiresAuth = userResolveContext !== undefined
  const resolveContext = userResolveContext ?? (async () => ({}))
  const authTimeoutMs = opts.authTimeoutMs ?? 10_000

  const hono = new Hono()
  const subToWs = new Map<string, WSContext>()

  hono.get(
    `${prefix}/ws`,
    createWebSocketRoute({
      app,
      upgradeWebSocket,
      requiresAuth,
      resolveContext,
      authTimeoutMs,
      subToWs,
    }),
  )

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
