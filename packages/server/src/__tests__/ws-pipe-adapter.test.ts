/**
 * Unit tests for the Hono WS→Pipe adapter built inside `createRoutes`.
 *
 * These bypass `Bun.serve` and drive the adapter directly through the injected
 * `upgradeWebSocket` seam: a fake captures the `{ onOpen, onMessage, onClose }`
 * handler factory, and a mock `WSContext` lets a test make `ws.send` throw on a
 * LIVE socket — something a real Bun socket won't do on demand.
 *
 * Regression target (PR #28 review, greptile P1 / codex-connector P2): the
 * committing `authenticated` ack is the one frame the engine `await`s so it can
 * close `transient` (4002) when the transport dies between a successful resolve
 * and the ack write. An adapter `send` that swallows the live-socket throw makes
 * that close path unreachable and strands the client on its ack timer.
 */
import { describe, test, expect } from 'bun:test'
import type { UpgradeWebSocket, WSContext, WSEvents } from 'hono/ws'
import { createDb } from '@wystack/db'
import { createWyStack } from '../create'
import { query } from '../functions'
import { createRoutes, type RouteOptions } from '../routes'

/** Poll until predicate holds — the engine's auth chain is async (microtasks). */
async function until(predicate: () => boolean, label: string, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`until(${label}) timed out`)
    await new Promise((r) => setTimeout(r, 1))
  }
}

/** Drain a few macrotask ticks — for asserting that NOTHING arrives. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20))
}

async function makeApp() {
  const db = await createDb({ dev: 'pglite://' })
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  return createWyStack({
    db,
    functions: { listTodos: query({ args: {}, handler: async () => [] }) },
  })
}

interface MockWs {
  raw: object
  sent: string[]
  closes: Array<{ code?: number; reason?: string }>
  /** When set, `send` throws this on every call — simulates a dead live socket. */
  sendThrows: boolean
  ctx: WSContext
}

function mockWs(opts: { sendThrows?: boolean } = {}): MockWs {
  const sent: string[] = []
  const closes: Array<{ code?: number; reason?: string }> = []
  const m: MockWs = {
    raw: {},
    sent,
    closes,
    sendThrows: opts.sendThrows ?? false,
    ctx: {} as WSContext,
  }
  m.ctx = {
    raw: m.raw,
    send: (data: string) => {
      if (m.sendThrows) throw new Error('socket dead')
      sent.push(String(data))
    },
    close: (code?: number, reason?: string) => {
      closes.push({ code, reason })
    },
  } as unknown as WSContext
  return m
}

/**
 * Build the route's WS event handlers without a server. Returns the captured
 * `{ onOpen, onMessage, onClose }` plus a synthetic upgrade Request.
 */
function captureWsEvents(opts: RouteOptions): WSEvents {
  let events: WSEvents | undefined
  const fakeUpgrade = ((createEvents: (c: never) => WSEvents | Promise<WSEvents>) => {
    // createRoutes calls this with a Hono handler factory; capture the events it
    // produces for our synthetic upgrade context, and hand back a no-op handler.
    const c = { req: { raw: new Request('http://localhost/api/ws') } }
    events = createEvents(c as never) as WSEvents
    return (async () => {}) as never
  }) as UpgradeWebSocket
  createRoutes(opts, fakeUpgrade)
  if (!events) throw new Error('upgradeWebSocket was never invoked')
  return events
}

function dataEvent(payload: unknown): MessageEvent {
  return { data: JSON.stringify(payload) } as MessageEvent
}

describe('Hono WS→Pipe adapter', () => {
  test('committing-ack send failure on a live socket → 4002 transient close', async () => {
    const app = await makeApp()
    // resolveContext configured → the auth frame triggers a committing ack.
    const events = captureWsEvents({ app, resolveContext: async () => ({ userId: 'u1' }) })
    const ws = mockWs({ sendThrows: true })

    events.onOpen?.({} as Event, ws.ctx)
    await events.onMessage?.(dataEvent({ type: 'auth', token: 'good' }), ws.ctx)

    // The ack write threw; the engine must map that to a transient (4002) close
    // rather than believe the ack landed. Before the fix, `send` swallowed the
    // throw and no close was issued.
    await until(
      () => ws.closes.some((x) => x.code === 4002),
      'transient close after ack-send failure',
    )
    expect(ws.closes).toContainEqual({ code: 4002, reason: 'transient' })
  })

  test('successful auth on a healthy socket → authenticated ack, no close', async () => {
    const app = await makeApp()
    const events = captureWsEvents({ app, resolveContext: async () => ({ userId: 'u1' }) })
    const ws = mockWs()

    events.onOpen?.({} as Event, ws.ctx)
    await events.onMessage?.(dataEvent({ type: 'auth', token: 'good' }), ws.ctx)

    await until(
      () => ws.sent.some((s) => JSON.parse(s).type === 'authenticated'),
      'authenticated ack',
    )
    expect(ws.sent.map((s) => JSON.parse(s).type)).toContain('authenticated')
    expect(ws.closes).toEqual([])
  })

  test('each connection gets a distinct Pipe id (no "[object Object]" collision)', async () => {
    // Indirect check: two onOpen calls must not throw and must be independently
    // tracked. The id itself is internal, but a shared-id regression surfaces as
    // cross-connection state bleed; here we assert the adapter handles two live
    // sockets independently (distinct close routing).
    const app = await makeApp()
    const events = captureWsEvents({ app, resolveContext: async () => ({ userId: 'u1' }) })
    const a = mockWs({ sendThrows: true })
    const b = mockWs()

    events.onOpen?.({} as Event, a.ctx)
    events.onOpen?.({} as Event, b.ctx)
    await events.onMessage?.(dataEvent({ type: 'auth', token: 'good' }), a.ctx)
    await events.onMessage?.(dataEvent({ type: 'auth', token: 'good' }), b.ctx)

    await until(
      () => a.closes.some((x) => x.code === 4002) && b.sent.length > 0,
      'both connections settled independently',
    )
    await flush()

    // a's dead socket closed 4002; b authenticated cleanly and stayed open.
    expect(a.closes).toContainEqual({ code: 4002, reason: 'transient' })
    expect(b.closes).toEqual([])
    expect(b.sent.map((s) => JSON.parse(s).type)).toContain('authenticated')
  })
})
