/**
 * Bun.serve() transport — HTTP + WebSocket.
 * - Queries: GET /wystack/:fn?args=... (cacheable, SSR-friendly)
 * - Mutations: POST /wystack/:fn (with JSON body)
 * - Subscriptions: WS /wystack/ws → receives invalidation signals
 */
import type { WyStackApp } from './create'
import type { ServerWebSocket } from 'bun'

interface ServeOptions {
  app: WyStackApp
  port?: number
  hostname?: string
  /** App-provided callback to build context from request (auth, tenant, etc.).
   *  WyStack never inspects the result — just passes it to function handlers. */
  resolveContext?: (req: Request) => Promise<Record<string, any>>
}

interface WsData {
  subscriptionIds: Set<string>
  context: Record<string, any>
}

export function serve(opts: ServeOptions) {
  const { app, port = 3000, hostname = '0.0.0.0' } = opts
  const resolveContext = opts.resolveContext ?? (async () => ({}))

  // Map subscription ID → owning WebSocket for targeted message delivery
  const subToWs = new Map<string, ServerWebSocket<WsData>>()

  const server = Bun.serve<WsData>({
    port,
    hostname,

    async fetch(req, server) {
      const url = new URL(req.url)

      // WebSocket upgrade — resolve context at connection time
      if (url.pathname === '/wystack/ws') {
        try {
          const context = await resolveContext(req)
          const upgraded = server.upgrade(req, {
            data: { subscriptionIds: new Set<string>(), context },
          })
          if (upgraded) return undefined as any
          return new Response('WebSocket upgrade failed', { status: 400 })
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 401 })
        }
      }

      // Extract function path from /wystack/:functionName
      if (!url.pathname.startsWith('/wystack/')) {
        return new Response('Not found', { status: 404 })
      }

      const functionPath = url.pathname.replace('/wystack/', '')
      const fn = app.functions.get(functionPath)

      if (!fn) {
        return Response.json({ error: `Unknown function: ${functionPath}` }, { status: 404 })
      }

      // Resolve context per request
      let context: Record<string, any>
      try {
        context = await resolveContext(req)
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 401 })
      }

      // GET: queries (cacheable, SSR-friendly)
      if (req.method === 'GET' && fn.type === 'query') {
        try {
          const argsParam = url.searchParams.get('args')
          const args = argsParam ? JSON.parse(argsParam) : {}
          const { result } = await app.call(functionPath, args, context)
          return Response.json({ data: result })
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 })
        }
      }

      // POST: mutations (and queries for backward compat)
      if (req.method === 'POST') {
        try {
          const body = await req.json().catch(() => ({}))
          const callResult = await app.call(functionPath, body, context)

          // If mutation wrote tables, send invalidation to affected WS subscribers
          if (fn.type === 'mutation' && callResult.tablesWritten.size > 0) {
            await invalidateSubscriptions(app, callResult.tablesWritten, subToWs)
          }

          return Response.json({ data: callResult.result })
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 })
        }
      }

      return new Response('Method not allowed', { status: 405 })
    },

    websocket: {
      open(_ws) {
        // Context already resolved during upgrade
      },

      async message(ws, rawMessage) {
        try {
          const msg = JSON.parse(String(rawMessage))

          if (msg.type === 'subscribe') {
            const { id, path, args } = msg
            const fn = app.functions.get(path)
            if (!fn || fn.type !== 'query') {
              ws.send(JSON.stringify({ type: 'error', id, error: `Unknown query: ${path}` }))
              return
            }

            // Execute query with connection's auth context to discover table dependencies
            const { tablesRead } = await app.call(path, args ?? {}, ws.data.context)

            // Register subscription
            app.subscriptions.add({
              id,
              functionPath: path,
              args: args ?? {},
              tablesWatched: tablesRead,
            })
            ws.data.subscriptionIds.add(id)
            subToWs.set(id, ws)

            // Confirm subscription (client fetches initial data via HTTP)
            ws.send(JSON.stringify({ type: 'subscribed', id }))
          }

          if (msg.type === 'unsubscribe') {
            const sub = app.subscriptions.get(msg.id)
            if (sub) {
              app.subscriptions.remove(msg.id)
              ws.data.subscriptionIds.delete(msg.id)
              subToWs.delete(msg.id)
            }
          }
        } catch (err: any) {
          ws.send(JSON.stringify({ type: 'error', error: err.message }))
        }
      },

      close(ws) {
        for (const id of ws.data.subscriptionIds) {
          app.subscriptions.remove(id)
          subToWs.delete(id)
        }
      },
    },
  })

  return server
}

async function invalidateSubscriptions(
  app: WyStackApp,
  writtenTables: Set<string>,
  subToWs: Map<string, ServerWebSocket<any>>,
) {
  const affected = app.subscriptions.getAffectedSubscriptions(writtenTables)

  for (const sub of affected) {
    const ws = subToWs.get(sub.id)
    if (!ws) continue

    // Re-run query to update table dependencies (tables watched may change)
    try {
      const { tablesRead } = await app.call(sub.functionPath, sub.args, ws.data.context)
      sub.tablesWatched = tablesRead
    } catch {
      // If re-query fails, keep existing table watches
    }

    // Send invalidation signal — client refetches via HTTP
    ws.send(JSON.stringify({ type: 'invalidate', id: sub.id }))
  }
}
