/**
 * Shared Hono app — both Bun and Node entrypoints import this.
 *
 * Simulates the WyStack transport.ts protocol:
 *   WS: subscribe → subscribed, unsubscribe, invalidate
 *   HTTP: POST mutation triggers invalidation to affected subscribers
 *
 * Uses an in-memory "counter" table to keep it minimal.
 *
 * GOTCHA: Hono creates a new WSContext wrapper per event callback.
 * You cannot use WSContext identity (===) across events. Instead, use
 * ws.raw to get the underlying platform socket for identity tracking.
 */
import { Hono } from 'hono'
import type { UpgradeWebSocket, WSContext } from 'hono/ws'

// ---------------------------------------------------------------------------
// Protocol types (mirrors transport.ts)
// ---------------------------------------------------------------------------

interface SubscribeMsg {
  type: 'subscribe'
  id: string
  path: string
  args?: Record<string, unknown>
}

interface UnsubscribeMsg {
  type: 'unsubscribe'
  id: string
}

type ClientMsg = SubscribeMsg | UnsubscribeMsg

interface Subscription {
  id: string
  path: string
  args: Record<string, unknown>
  tablesWatched: Set<string>
}

// ---------------------------------------------------------------------------
// Fake function registry — just enough to prove the protocol
// ---------------------------------------------------------------------------

const store = { counter: 0 }

interface QueryResult {
  result: unknown
  tablesRead: Set<string>
}

interface MutationResult {
  result: unknown
  tablesWritten: Set<string>
}

function getCounter(_args: Record<string, unknown>): QueryResult {
  return { result: { value: store.counter }, tablesRead: new Set(['counters']) }
}

function increment(_args: Record<string, unknown>): MutationResult {
  store.counter++
  return { result: { value: store.counter }, tablesWritten: new Set(['counters']) }
}

const queryFns: Record<string, typeof getCounter> = { getCounter }
const mutationFns: Record<string, typeof increment> = { increment }

// ---------------------------------------------------------------------------
// Subscription registry
//
// GOTCHA: Hono's WSContext is recreated per event — can't use === to match
// sockets across onMessage/onClose. Use ws.raw (the platform socket) as the
// stable identity key instead.
// ---------------------------------------------------------------------------

const subscriptions = new Map<string, Subscription>()
/** subscription id → WSContext (for sending) */
const subToWs = new Map<string, WSContext>()
/** raw platform socket → set of subscription ids (for cleanup on close) */
const rawToSubIds = new Map<unknown, Set<string>>()

function getAffected(tablesWritten: Set<string>): Subscription[] {
  const out: Subscription[] = []
  for (const sub of subscriptions.values()) {
    for (const t of sub.tablesWatched) {
      if (tablesWritten.has(t)) {
        out.push(sub)
        break
      }
    }
  }
  return out
}

function addSub(id: string, sub: Subscription, ws: WSContext): void {
  subscriptions.set(id, sub)
  subToWs.set(id, ws)
  let ids = rawToSubIds.get(ws.raw)
  if (!ids) {
    ids = new Set()
    rawToSubIds.set(ws.raw, ids)
  }
  ids.add(id)
}

function removeSub(id: string, ws: WSContext): void {
  subscriptions.delete(id)
  subToWs.delete(id)
  rawToSubIds.get(ws.raw)?.delete(id)
}

function removeAllForSocket(ws: WSContext): void {
  const ids = rawToSubIds.get(ws.raw)
  if (!ids) return
  for (const id of ids) {
    subscriptions.delete(id)
    subToWs.delete(id)
  }
  rawToSubIds.delete(ws.raw)
}

// ---------------------------------------------------------------------------
// Track connection count for leak detection
// ---------------------------------------------------------------------------

export let openConnections = 0

// ---------------------------------------------------------------------------
// Hono app factory — caller passes upgradeWebSocket from their adapter
// ---------------------------------------------------------------------------

export function createApp(upgradeWebSocket: UpgradeWebSocket) {
  const app = new Hono()

  // Health check + diagnostics
  app.get('/', (c) =>
    c.json({
      status: 'ok',
      openConnections,
      subscriptions: subscriptions.size,
      trackedSockets: rawToSubIds.size,
    }),
  )

  // --- WebSocket (must be before /wystack/:fn to avoid param catch) ---
  app.get(
    '/wystack/ws',
    upgradeWebSocket(() => {
      return {
        onOpen(_evt, _ws) {
          openConnections++
        },

        onMessage(event, ws) {
          let msg: ClientMsg | undefined
          try {
            msg = JSON.parse(String(event.data)) as ClientMsg

            if (msg.type === 'subscribe') {
              const { id, path, args = {} } = msg
              const fn = queryFns[path]
              if (!fn) {
                ws.send(
                  JSON.stringify({ type: 'error', id, error: `Unknown query: ${path}` }),
                )
                return
              }

              const { tablesRead } = fn(args)
              addSub(id, { id, path, args, tablesWatched: tablesRead }, ws)
              ws.send(JSON.stringify({ type: 'subscribed', id }))
            }

            if (msg.type === 'unsubscribe') {
              removeSub(msg.id, ws)
              ws.send(JSON.stringify({ type: 'unsubscribed', id: msg.id }))
            }
          } catch (err: unknown) {
            const payload: Record<string, unknown> = {
              type: 'error',
              error: err instanceof Error ? err.message : String(err),
            }
            if (msg?.id) payload.id = msg.id
            ws.send(JSON.stringify(payload))
          }
        },

        onClose(_evt, ws) {
          openConnections--
          removeAllForSocket(ws)
        },
      }
    }),
  )

  // --- HTTP: queries ---
  app.get('/wystack/:fn', (c) => {
    const fnName = c.req.param('fn')
    const fn = queryFns[fnName]
    if (!fn) return c.json({ error: `Unknown query: ${fnName}` }, 404)

    const argsParam = c.req.query('args')
    const args: Record<string, unknown> = argsParam ? JSON.parse(argsParam) : {}
    const { result } = fn(args)
    return c.json({ data: result })
  })

  // --- HTTP: mutations ---
  app.post('/wystack/:fn', async (c) => {
    const fnName = c.req.param('fn')
    const fn = mutationFns[fnName]
    if (!fn) return c.json({ error: `Unknown mutation: ${fnName}` }, 404)

    const body: Record<string, unknown> = await c.req.json().catch(() => ({}))
    const { result, tablesWritten } = fn(body)

    // Invalidate affected WS subscribers
    if (tablesWritten.size > 0) {
      const affected = getAffected(tablesWritten)
      for (const sub of affected) {
        const ws = subToWs.get(sub.id)
        if (!ws) continue
        // Re-run query to refresh table deps (mirrors transport.ts)
        const queryFn = queryFns[sub.path]
        if (queryFn) {
          const { tablesRead } = queryFn(sub.args)
          sub.tablesWatched = tablesRead
        }
        ws.send(JSON.stringify({ type: 'invalidate', id: sub.id }))
      }
    }

    return c.json({ data: result })
  })

  return app
}
