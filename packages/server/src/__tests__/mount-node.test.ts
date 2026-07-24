// Process-collapse mechanism — proven over a REAL WebSocket.
//
// This is the wire-level counterpart to cross-surface-invalidation.test.ts: it
// mounts WyStack's routes onto a plain Node http.Server (the way the collapsed
// dev/prod host will), connects an actual `ws` client, subscribes, then drives a
// write via in-process `app.call` — the REST surface's path. If the client
// receives an `invalidate` frame, one process + one app carried a REST-side write
// to a live WS subscriber. That is exactly the split-store bug, fixed.
//
// It also pins the Vite-safety contract: `handleUpgrade` must ignore (never
// destroy) an upgrade outside its prefix, so it can share a server with Vite's
// HMR socket.

import { describe, test, expect } from 'bun:test'
import { createServer, type IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { defineApp, mountNodeRoutes } from '../index'

const schema = defineSchema({
  todos: { id: int.primaryKey(), title: text, done: boolean },
})
const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const functions = {
  listTodos: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.todos).all()),
  addTodo: wy.procedure.input({ title: text }).mutation(async (ctx, args) => {
    return ctx.db.into(schema.todos).insert({ title: args.title, done: false })
  }),
}

async function makeApp() {
  const pg = new PGlite()
  const db = drizzle(pg)
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  return wy.build({ db, functions })
}

async function until(cond: () => boolean, deadlineMs = 3000): Promise<boolean> {
  const start = performance.now()
  while (performance.now() - start < deadlineMs) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return cond()
}

describe('mountNodeRoutes — collapse mechanism over a real socket', () => {
  test('in-process app.call write reaches a live WS subscriber (one process, one app)', async () => {
    const app = await makeApp()
    const { handleUpgrade, requestListener } = mountNodeRoutes({ app, prefix: '/wystack' })

    // The host routes /wystack HTTP to requestListener; everything else is 404.
    // This mirrors the collapsed host: one server, WyStack under a prefix.
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/wystack')) return requestListener(req, res)
      res.writeHead(404)
      res.end()
    })
    server.on('upgrade', handleUpgrade)
    await new Promise<void>((resolve) => server.listen(0, resolve))
    const port = (server.address() as AddressInfo).port

    const frames: Array<{ type?: string; id?: string }> = []
    const ws = new WebSocket(`ws://localhost:${port}/wystack/ws`)
    ws.on('message', (data) => frames.push(JSON.parse(String(data))))

    try {
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      })

      // No resolveContext ⇒ the connection starts authenticated ⇒ subscribe
      // directly. Server acks with `subscribed`.
      ws.send(JSON.stringify({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} }))
      expect(await until(() => frames.some((f) => f.type === 'subscribed'))).toBe(true)

      // Drive a write the REST surface's way: in-process app.call on the SAME app
      // instance the routes were mounted with. No manual emit, no client mutation.
      await app.call('addTodo', { title: 'buy milk' }, {})

      // The subscriber must receive an invalidate for its subscription id.
      expect(await until(() => frames.some((f) => f.type === 'invalidate' && f.id === 's1'))).toBe(
        true,
      )

      // And the HTTP surface (requestListener) serves the query same-origin: the
      // write above persisted, so the REST query now returns the row.
      const res = await fetch(`http://localhost:${port}/wystack/listTodos`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as { data: Array<{ title: string }> }
      expect(body.data.some((t) => t.title === 'buy milk')).toBe(true)
    } finally {
      ws.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  test('handleUpgrade ignores (never destroys) an upgrade outside its prefix', () => {
    const app = { invalidationSource: { onInvalidation: () => () => {} } }
    // Build a mount with a stub app — we only exercise the path gate here, which
    // runs before any app dispatch. createRoutes wires a router to
    // app.invalidationSource, so a minimal stub suffices.
    const { handleUpgrade } = mountNodeRoutes({
      // oxlint-disable-next-line typescript/no-explicit-any -- path-gate test needs no real dispatch
      app: app as any,
      prefix: '/wystack',
    })

    let ended = false
    let destroyed = false
    const socket = {
      end: () => {
        ended = true
      },
      destroy: () => {
        destroyed = true
      },
    } as unknown as Duplex
    const req = { url: '/_vite_hmr', headers: {} } as IncomingMessage

    handleUpgrade(req, socket, Buffer.alloc(0))

    // A foreign upgrade must be left untouched for other listeners (Vite HMR).
    expect(ended).toBe(false)
    expect(destroyed).toBe(false)
  })
})
