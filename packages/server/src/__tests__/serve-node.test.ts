// serve-node lifecycle — the two places Node does not behave like Bun.
//
// Both were reachable through the documented API and neither had coverage:
// every existing `serve()` test drives the BUN entrypoint, so the Node
// wrapper's bind timing and teardown were only ever exercised indirectly.

import { describe, test, expect } from 'bun:test'
import { WebSocket } from 'ws'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { defineApp } from '../index'
import { serve } from '../serve-node'

const schema = defineSchema({
  todos: { id: int.primaryKey(), title: text, done: boolean },
})
const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const functions = {
  listTodos: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.todos).all()),
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

describe('serve (Node) — bind readiness', () => {
  // Pins the contract rather than being red/green: without `ready` there is no
  // point at which a caller can correctly read an ephemeral `.port`, so the
  // absence of this field is the defect. What IS asserted behaviourally is that
  // the port is real once ready resolves, and that the pre-ready read is the
  // placeholder — i.e. awaiting is genuinely load-bearing, not decorative.
  test('an ephemeral port is only accurate after ready resolves', async () => {
    const app = await makeApp()
    const server = serve({ app, port: 0 })

    // Read synchronously, before the listening callback can have run.
    const portBeforeReady = server.port

    await server.ready

    try {
      expect(portBeforeReady).toBe(0)
      expect(server.port).toBeGreaterThan(0)

      // The port is not merely non-zero — it is the one actually bound.
      const res = await fetch(`http://localhost:${server.port}/api/listTodos`)
      expect(res.ok).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test('ready rejects when the port is already bound', async () => {
    const app = await makeApp()
    const first = serve({ app, port: 0 })
    await first.ready

    // Contend for the port the first server already holds.
    const second = serve({ app: await makeApp(), port: first.port })

    try {
      // Must reject, not hang. A pending-forever `ready` would make a bind
      // failure indistinguishable from a slow start.
      //
      // Asserted by catching explicitly rather than via `.rejects`, which is
      // typed as synchronous here and would pass vacuously if `ready` never
      // settled — precisely the failure this test exists to rule out.
      let rejection: unknown
      await second.ready.then(
        () => {},
        (err) => {
          rejection = err
        },
      )
      expect(rejection).toBeInstanceOf(Error)
    } finally {
      second.stop(true)
      first.stop(true)
    }
  })
})

// COVERAGE CAVEAT — read before trusting these two tests.
//
// They pass with OR without the explicit socket teardown in serve-node, so
// under `bun test` they are not regression tests. Bun's `node:http` shim closes
// upgraded sockets on `closeAllConnections()`; real Node does not, and real
// Node is the only runtime `serve-node` exists for (Electron main).
//
// The defect and the fix were verified directly against Node v25.8.2:
//   closeAllConnections() + close()  → websocket still open   (the bug)
//   explicit destroy of the socket   → websocket closed       (the fix)
//
// Kept because they pin intent and would catch a regression if the suite ever
// runs on Node. They must NOT be read as proof on Bun. Closing this gap needs a
// real-Node test runner for this file — there is currently none.
describe('serve (Node) — teardown', () => {
  test('stop(true) terminates upgraded WebSocket connections', async () => {
    const app = await makeApp()
    const server = serve({ app, port: 0 })
    await server.ready

    const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    let closed = false
    ws.on('close', () => {
      closed = true
    })

    server.stop(true)

    expect(await until(() => closed)).toBe(true)
  })

  // The complement: graceful stop deliberately leaves live sockets alone, which
  // is what makes it graceful. Without this, "close everything on stop" would
  // look like an equally valid fix and would silently drop in-flight work.
  test('stop() without immediate leaves an open WebSocket connected', async () => {
    const app = await makeApp()
    const server = serve({ app, port: 0 })
    await server.ready

    const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`)
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', reject)
    })

    let closed = false
    ws.on('close', () => {
      closed = true
    })

    server.stop()

    // Give a close a fair chance to arrive before asserting it did not.
    await new Promise((r) => setTimeout(r, 150))
    expect(closed).toBe(false)

    ws.close()
    server.stop(true)
  })
})
