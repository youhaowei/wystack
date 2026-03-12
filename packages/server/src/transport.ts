/**
 * Bun.serve() transport — HTTP for queries/mutations, WebSocket for subscriptions.
 * Reactive flow: mutation → TrackedDb records tables → find affected subs → re-run → send to owning ws.
 */
import type { WyStackApp } from './create'
import type { ServerWebSocket } from 'bun'

interface ServeOptions {
  app: WyStackApp
  port?: number
  hostname?: string
}

interface WsData {
  subscriptionIds: Set<string>
}

export function serve(opts: ServeOptions) {
  const { app, port = 3000, hostname = '0.0.0.0' } = opts

  // Map subscription ID → owning WebSocket for targeted message delivery
  const subToWs = new Map<string, ServerWebSocket<WsData>>()

  const server = Bun.serve<WsData>({
    port,
    hostname,

    async fetch(req, server) {
      const url = new URL(req.url)

      // WebSocket upgrade
      if (url.pathname === '/wystack/ws') {
        const upgraded = server.upgrade(req, {
          data: { subscriptionIds: new Set<string>() },
        })
        if (upgraded) return undefined as any
        return new Response('WebSocket upgrade failed', { status: 400 })
      }

      // HTTP: POST /wystack/:functionName
      if (req.method === 'POST' && url.pathname.startsWith('/wystack/')) {
        const functionPath = url.pathname.replace('/wystack/', '')
        const fn = app.functions.get(functionPath)

        if (!fn) {
          return Response.json({ error: `Unknown function: ${functionPath}` }, { status: 404 })
        }

        try {
          const body = await req.json().catch(() => ({}))
          const callResult = await app.call(functionPath, body)

          // If mutation wrote tables, invalidate subscriptions
          if (fn.type === 'mutation' && callResult.tablesWritten.size > 0) {
            await invalidateSubscriptions(app, callResult.tablesWritten, subToWs)
          }

          return Response.json({ data: callResult.result })
        } catch (err: any) {
          return Response.json({ error: err.message }, { status: 500 })
        }
      }

      return new Response('Not found', { status: 404 })
    },

    websocket: {
      open(_ws) {
        // Client sends subscribe messages after connecting
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

            // Execute query and track which tables it reads
            const { result, tablesRead } = await app.call(path, args ?? {})

            // Register subscription with ownership tracking
            app.subscriptions.add({
              id,
              functionPath: path,
              args: args ?? {},
              tablesWatched: tablesRead,
            })
            ws.data.subscriptionIds.add(id)
            subToWs.set(id, ws)

            // Send initial result
            ws.send(JSON.stringify({ type: 'data', id, data: result }))
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
        // Clean up all subscriptions owned by this socket
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

  // Deduplicate — each subscription gets exactly one re-query + send
  for (const sub of affected) {
    const ws = subToWs.get(sub.id)
    if (!ws) continue

    try {
      const { result, tablesRead } = await app.call(sub.functionPath, sub.args)

      // Update watched tables in case query now reads different tables
      sub.tablesWatched = tablesRead

      // Send directly to the owning WebSocket
      ws.send(JSON.stringify({ type: 'data', id: sub.id, data: result }))
    } catch (err: any) {
      ws.send(JSON.stringify({ type: 'error', id: sub.id, error: err.message }))
    }
  }
}
