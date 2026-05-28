/**
 * Engine tests — drive the full auth + subscribe + invalidation path via
 * `createLoopbackPair()`. No Hono, no Bun.serve, no WebSocket server.
 * These tests are the primary proof that the engine honours ADR #8 / ADR #12.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { createLoopbackPair } from '@wystack/transport'
import { createDb, defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack } from '../../create'
import { query, mutation } from '../../functions'
import { createEngine } from '../index'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
})

// Synthetic upgrade Request for non-HTTP transports.
const SYNTHETIC_REQUEST = new Request('http://localhost/engine')

async function makeApp() {
  const db = await createDb({ dev: 'pglite://' })
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  const app = await createWyStack({
    db,
    functions: {
      listTodos: query({ args: {}, handler: async (ctx) => ctx.db.from(schema.todos).all() }),
      addTodo: mutation({
        args: { title: text },
        handler: async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ title: args.title, done: false }),
      }),
      whoami: query({
        args: {},
        handler: async (ctx) => ({ userId: ctx.userId as string | undefined }),
      }),
    },
  })
  return app
}

/** Send a JSON message from the client end and collect one reply. */
function nextMessage(
  clientPipe: ReturnType<typeof createLoopbackPair>[0],
): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const unsub = clientPipe.onMessage((raw: unknown) => {
      unsub()
      resolve(JSON.parse(String(raw)) as Record<string, unknown>)
    })
  })
}

function sendJson(pipe: ReturnType<typeof createLoopbackPair>[0], payload: unknown): void {
  pipe.send(JSON.stringify(payload))
}

// ─── No-auth engine (trusted transport) ───────────────────────────────────────

describe('Engine — no-auth (trusted transport)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    app = await makeApp()
  })

  test('subscribe returns REACTIVITY_NOT_ENABLED when reactive tier is not wired', async () => {
    const engine = createEngine(app) // no subscriptions → reactive tier off
    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    const reply = nextMessage(clientPipe)
    sendJson(clientPipe, { type: 'subscribe', id: 'sub1', path: 'listTodos', args: {} })
    const msg = await reply

    expect(msg.type).toBe('error')
    expect(msg.error).toBe('REACTIVITY_NOT_ENABLED')

    clientPipe.close()
  })

  test('auth frame on no-auth engine sends idempotent ACK', async () => {
    const engine = createEngine(app)
    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    const reply = nextMessage(clientPipe)
    sendJson(clientPipe, { type: 'auth', token: 'anything' })
    const msg = await reply

    expect(msg.type).toBe('authenticated')

    clientPipe.close()
  })

  test('subscribe + subscribed with reactive tier wired', async () => {
    const engine = createEngine(app, { subscriptions: app.subscriptions })
    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    const reply = nextMessage(clientPipe)
    sendJson(clientPipe, { type: 'subscribe', id: 'sub1', path: 'listTodos', args: {} })
    const msg = await reply

    expect(msg.type).toBe('subscribed')
    expect(msg.id).toBe('sub1')

    clientPipe.close()
  })

  test('subscribe to unknown query returns error', async () => {
    const engine = createEngine(app, { subscriptions: app.subscriptions })
    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    const reply = nextMessage(clientPipe)
    sendJson(clientPipe, { type: 'subscribe', id: 'sub1', path: 'nonexistent', args: {} })
    const msg = await reply

    expect(msg.type).toBe('error')

    clientPipe.close()
  })

  test('unknown message type post-auth returns error frame', async () => {
    const engine = createEngine(app)
    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    const reply = nextMessage(clientPipe)
    sendJson(clientPipe, { type: 'call', id: 'r1', path: 'listTodos', args: {} })
    const msg = await reply

    expect(msg.type).toBe('error')

    clientPipe.close()
  })
})

// ─── Auth engine ──────────────────────────────────────────────────────────────

describe('Engine — auth (resolveContext)', () => {
  let app: Awaited<ReturnType<typeof makeApp>>

  beforeEach(async () => {
    app = await makeApp()
  })

  test('auth frame with valid token → authenticated', async () => {
    const engine = createEngine(app, {
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    const reply = nextMessage(clientPipe)
    sendJson(clientPipe, { type: 'auth', token: 'user_123' })
    const msg = await reply

    expect(msg.type).toBe('authenticated')

    clientPipe.close()
  })

  test('auth frame with invalid token → pipe closed', async () => {
    const engine = createEngine(app, {
      resolveContext: async () => {
        throw new Error('Unauthorized')
      },
    })

    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })
    const closedPromise = new Promise<boolean>((resolve) => {
      // Pipe.close() is idempotent and cascades to the partner in loopback;
      // detecting closure: onMessage returns a no-op after close, so instead
      // we wait for the partner to also be closed by attempting a send.
      // Simpler: just check state after a tick.
      setTimeout(() => {
        // After auth failure, server closes the pipe. Send should be silently
        // dropped on a closed loopback.
        const countBefore = msgs.length
        clientPipe.send('test-after-close')
        // Give a microtask cycle for delivery — should not arrive.
        queueMicrotask(() => resolve(msgs.length === countBefore))
      }, 50)
    })
    const msgs: unknown[] = []
    clientPipe.onMessage((m: unknown) => msgs.push(m))

    sendJson(clientPipe, { type: 'auth', token: null })
    expect(await closedPromise).toBe(true)
  })

  test('subscribe before auth → pipe closed', async () => {
    const engine = createEngine(app, {
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    // Don't auth first — send subscribe directly
    const msgs: unknown[] = []
    clientPipe.onMessage((m: unknown) => msgs.push(m))
    sendJson(clientPipe, { type: 'subscribe', id: 'sub1', path: 'listTodos', args: {} })

    // After a tick, pipe should be closed (no response, client end closed)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // Closed loopback: further sends from client side are no-ops
    const countBefore = msgs.length
    clientPipe.send('probe')
    await new Promise<void>((resolve) => queueMicrotask(() => resolve()))
    expect(msgs.length).toBe(countBefore) // no delivery

    clientPipe.close()
  })

  test('auth timeout closes the pipe', async () => {
    const engine = createEngine(app, {
      authTimeoutMs: 50,
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    // Don't send auth — wait for timeout to fire
    const closed = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        // After timeout, the server pipe should be closed → loopback cascades
        const before: unknown[] = []
        const unsub = clientPipe.onMessage((m: unknown) => before.push(m))
        clientPipe.send('probe')
        queueMicrotask(() => {
          unsub()
          // If pipe is closed, send to serverPipe is a no-op → no echo
          resolve(before.length === 0)
        })
      }, 100)
    })
    expect(await closed).toBe(true)
  })

  test('context injected into subscription handler', async () => {
    const engine = createEngine(app, {
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
      subscriptions: app.subscriptions,
    })

    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    // Collect messages in order
    const messages: Record<string, unknown>[] = []
    let resolveDone: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    clientPipe.onMessage((raw: unknown) => {
      const msg = JSON.parse(String(raw)) as Record<string, unknown>
      messages.push(msg)
      if (msg.type === 'subscribed') resolveDone()
    })

    sendJson(clientPipe, { type: 'auth', token: 'user_abc' })
    // Wait for authenticated before subscribing
    await new Promise<void>((resolve) => {
      const unsub = clientPipe.onMessage((raw: unknown) => {
        const m = JSON.parse(String(raw)) as Record<string, unknown>
        if (m.type === 'authenticated') {
          unsub()
          resolve()
        }
      })
    })

    sendJson(clientPipe, { type: 'subscribe', id: 'sub-ctx', path: 'whoami', args: {} })
    await done

    const sub = app.subscriptions.get('sub-ctx')
    expect(sub).toBeDefined()
    expect((sub?.context as Record<string, unknown>)?.userId).toBe('user_abc')

    clientPipe.close()
  })

  test('unsubscribe cancels a pending in-flight subscribe', async () => {
    const engine = createEngine(app, {
      subscriptions: app.subscriptions,
    })
    const [clientPipe, serverPipe] = createLoopbackPair()
    engine.attach(serverPipe, { upgradeRequest: SYNTHETIC_REQUEST })

    // Send subscribe and immediately unsubscribe before the microtask delivers
    sendJson(clientPipe, { type: 'subscribe', id: 'sub-cancel', path: 'listTodos', args: {} })
    sendJson(clientPipe, { type: 'unsubscribe', id: 'sub-cancel' })

    // Wait a tick for any async work to settle
    await new Promise((resolve) => setTimeout(resolve, 30))

    // Sub should NOT be in the store
    expect(app.subscriptions.get('sub-cancel')).toBeUndefined()

    clientPipe.close()
  })
})

// ─── dispatch (pure RPC) ──────────────────────────────────────────────────────

describe('Engine.dispatch (pure RPC)', () => {
  test('calls a registered query and returns result', async () => {
    const app = await makeApp()
    const engine = createEngine(app)

    const { result } = await engine.dispatch('listTodos', {}, {})
    expect(result).toEqual([])
  })

  test('calls a mutation and returns written tables', async () => {
    const app = await makeApp()
    const engine = createEngine(app)

    const { result, tablesWritten } = await engine.dispatch('addTodo', { title: 'test' }, {})
    expect((result as unknown[]).length).toBeGreaterThan(0)
    expect(tablesWritten.size).toBeGreaterThan(0)
  })
})
