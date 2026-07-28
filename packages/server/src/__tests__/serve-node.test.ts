// serve-node lifecycle — the two places Node does not behave like Bun.
//
// Both were reachable through the documented API and neither had coverage:
// every existing `serve()` test drives the BUN entrypoint, so the Node
// wrapper's bind timing and teardown were only ever exercised indirectly.

import { describe, test, expect, afterAll } from 'bun:test'
import { Server } from 'node:http'
import { WebSocket } from 'ws'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { defineApp } from '../index'
import { serve } from '../serve-node'

// `@hono/node-server`'s serve() replaces `globalThis.Response` with its own
// optimised subclass the first time it is called — a process-wide side effect,
// not a per-server one. Every OTHER test file in this suite serves over
// `Bun.serve`, which validates the handler's return value by identity and
// rejects the replacement with "Expected a Response object, but received
// '_Response'". Bun runs the whole suite in one process, so without this the
// damage is order-dependent: harmless when this file happens to run last (macOS
// locally) and five unrelated failures when it does not (Linux CI).
//
// Capture the native class at load, before anything here calls serve(), and put
// it back once this file is done.
const nativeResponse = globalThis.Response
afterAll(() => {
  globalThis.Response = nativeResponse
})

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

  // Node cancels a pending listen() on close() silently — no listening
  // callback, no 'error' — so a stop() issued while startup is still in
  // flight (shutdown racing init, or cleanup after a startup that never
  // finished binding) would otherwise leave `ready` pending forever. Bounded
  // by a race against a timer so a regression fails this assertion instead of
  // hanging the test run.
  test('ready settles when stop() races startup', async () => {
    const app = await makeApp()
    const server = serve({ app, port: 0 })

    // Stop immediately — before the async listen() has any chance to land.
    server.stop(true)

    let outcome: 'resolved' | 'rejected' | 'timed-out' = 'timed-out'
    let rejection: unknown
    await Promise.race([
      server.ready.then(
        () => {
          outcome = 'resolved'
        },
        (err) => {
          outcome = 'rejected'
          rejection = err
        },
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 1000)),
    ])

    expect(outcome).not.toBe('timed-out')
    // Rejecting (rather than resolving to a "stopped" state) matches the
    // existing bind-failure path and surfaces at the caller's own `await`.
    expect(outcome).toBe('rejected')
    expect(rejection).toBeInstanceOf(Error)
  })
})

// Bun's `node:http` shim closes upgraded sockets as a side effect of
// `closeAllConnections()`; real Node's does not — which is exactly why
// `stop(true)` has to destroy them itself (see serve-node.ts). Left alone,
// that means "stop(true) terminates upgraded WebSocket connections" below
// would pass under `bun test` with or without serve-node's own destroy loop:
// Bun's shim papers over the bug this suite exists to catch.
//
// So that test stubs `Server.prototype.closeAllConnections` to a no-op for
// its duration, removing Bun's shim from the equation. What is left standing
// is only serve-node's explicit `socket.destroy()` loop — verified by
// deleting that loop locally and watching this test fail under `bun test`
// (previously it would still pass). The complement test (graceful stop) needs
// no such stub: it asserts the ABSENCE of teardown, which does not depend on
// which runtime's `closeAllConnections` shim is in play.
describe('serve (Node) — teardown', () => {
  test('stop(true) explicitly destroys upgraded sockets', async () => {
    const app = await makeApp()
    const server = serve({ app, port: 0 })
    let ws: WebSocket | undefined

    const originalCloseAllConnections = Server.prototype.closeAllConnections
    Server.prototype.closeAllConnections = function () {
      // no-op — see the block comment above.
    }

    try {
      await server.ready

      ws = new WebSocket(`ws://localhost:${server.port}/api/ws`)
      await new Promise<void>((resolve, reject) => {
        ws!.on('open', () => resolve())
        ws!.on('error', reject)
      })

      let closed = false
      ws.on('close', () => {
        closed = true
      })

      server.stop(true)

      expect(await until(() => closed)).toBe(true)
    } finally {
      Server.prototype.closeAllConnections = originalCloseAllConnections
      ws?.close()
      server.stop(true)
    }
  })

  // The complement: graceful stop deliberately leaves live sockets alone, which
  // is what makes it graceful. Without this, "close everything on stop" would
  // look like an equally valid fix and would silently drop in-flight work.
  test('stop() without immediate leaves an open WebSocket connected', async () => {
    const app = await makeApp()
    const server = serve({ app, port: 0 })
    let ws: WebSocket | undefined

    try {
      await server.ready

      ws = new WebSocket(`ws://localhost:${server.port}/api/ws`)
      await new Promise<void>((resolve, reject) => {
        ws!.on('open', () => resolve())
        ws!.on('error', reject)
      })

      let closed = false
      ws.on('close', () => {
        closed = true
      })

      server.stop()

      // Give a close a fair chance to arrive before asserting it did not.
      await new Promise((r) => setTimeout(r, 150))
      expect(closed).toBe(false)
    } finally {
      ws?.close()
      server.stop(true)
    }
  })
})
