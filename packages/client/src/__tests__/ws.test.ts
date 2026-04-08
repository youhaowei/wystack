import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createDb, defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack, query, mutation } from '@wystack/server'
import { serve } from '@wystack/server/bun'
import { createClient } from '../client'
import { createWsManager } from '../ws'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
})

// Per-test app factory for auth scenarios — each test creates its own
// PGlite + createWyStack so resolveContext can vary freely.
async function makeAuthApp() {
  const db = await createDb({ dev: 'pglite://' })
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  return createWyStack({
    db,
    functions: {
      listTodos: query({
        args: {},
        handler: async (ctx) => ctx.db.from(schema.todos).all(),
      }),
      addTodo: mutation({
        args: { title: text },
        handler: async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ title: args.title, done: false }),
      }),
    },
  })
}

let server: ReturnType<typeof serve>
let wsUrl: string
let baseUrl: string

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, message = 'timeout'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 5000)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

async function waitForConnected(ws: ReturnType<typeof createWsManager>) {
  await withTimeout(
    new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ws.isConnected()) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    }),
    'timeout waiting for connection',
  )
}

beforeEach(async () => {
  const db = await createDb({ dev: 'pglite://' })
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL
    )
  `)

  const app = await createWyStack({
    db,
    functions: {
      listTodos: query({
        args: {},
        handler: async (ctx) => ctx.db.from(schema.todos).all(),
      }),
      addTodo: mutation({
        args: { title: text },
        handler: async (ctx, args) => {
          return ctx.db.into(schema.todos).insert({ title: args.title, done: false })
        },
      }),
    },
  })

  server = serve({ app, port: 0 })
  wsUrl = `ws://localhost:${server.port}/api/ws`
  baseUrl = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

describe('WsManager', () => {
  test('connects and reports connected', async () => {
    const ws = createWsManager({ url: wsUrl })
    ws.connect()

    await waitForConnected(ws)

    expect(ws.isConnected()).toBe(true)
    ws.disconnect()
    expect(ws.isConnected()).toBe(false)
  })

  test('receives invalidation after mutation', async () => {
    const subscribed = deferred<void>()
    const invalidated = deferred<void>()
    const ws = createWsManager({
      url: wsUrl,
      onSubscribed: (id) => {
        if (id === 'sub1') subscribed.resolve()
      },
    })
    ws.connect()

    await waitForConnected(ws)
    ws.subscribe('sub1', 'listTodos', {}, () => invalidated.resolve())
    await withTimeout(subscribed.promise, 'timeout waiting for subscription')

    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'From WS test' }),
    })

    await withTimeout(invalidated.promise, 'timeout waiting for invalidation')
    ws.disconnect()
  })

  test('unsubscribe stops receiving invalidations', async () => {
    const subscribed = deferred<void>()
    const firstInvalidation = deferred<void>()
    const ws = createWsManager({
      url: wsUrl,
      onSubscribed: (id) => {
        if (id === 'sub1') subscribed.resolve()
      },
    })
    ws.connect()

    await waitForConnected(ws)

    let invalidateCount = 0
    ws.subscribe('sub1', 'listTodos', {}, () => {
      invalidateCount++
      firstInvalidation.resolve()
    })
    await withTimeout(subscribed.promise, 'timeout waiting for subscription')

    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'First' }),
    })

    await withTimeout(firstInvalidation.promise, 'timeout waiting for invalidation')
    expect(invalidateCount).toBe(1)

    ws.unsubscribe('sub1')
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Second' }),
    })

    await new Promise((r) => setTimeout(r, 200))
    expect(invalidateCount).toBe(1)

    ws.disconnect()
  })

  test('sends auth handshake and buffers subscribes until authenticated', async () => {
    // Separate server requiring auth
    const app = await makeAuthApp()

    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    try {
      const subscribed = deferred<void>()
      const invalidated = deferred<void>()
      const ws = createWsManager({
        url: `ws://localhost:${authServer.port}/api/ws`,
        getToken: () => 'user_123',
        onSubscribed: (id) => {
          if (id === 'sub1') subscribed.resolve()
        },
      })
      ws.connect()

      // Count per-handler calls so we can assert exactly-one-fires, not just
      // that *something* resolved the promise. Catches mechanism-change
      // regressions where the handler could fire for the wrong sub or twice.
      let sub1Invalidations = 0
      // Call subscribe immediately — before WS even opens. Must not lose the sub.
      ws.subscribe('sub1', 'listTodos', {}, () => {
        sub1Invalidations++
        invalidated.resolve()
      })
      await withTimeout(subscribed.promise, 'timeout waiting for subscription')

      await fetch(`http://localhost:${authServer.port}/api/addTodo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer user_123',
        },
        body: JSON.stringify({ title: 'Authed' }),
      })

      await withTimeout(invalidated.promise, 'timeout waiting for invalidation')

      // Prove the buffered-subscribe-then-flush actually happened end-to-end:
      expect(sub1Invalidations).toBe(1)
      expect(ws.isConnected()).toBe(true)

      ws.disconnect()
    } finally {
      authServer.stop(true)
    }
  })

  test('requiresAuth:true without getToken sends null-token auth frame (cookie/session auth)', async () => {
    // Simulates a server that uses resolveContext for cookie/proxy-header auth —
    // no JWT, but the client still needs to trigger the handshake so the server
    // can run resolveContext against the upgrade request headers.
    const app = await makeAuthApp()

    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (_req) => {
        // In real usage this would read cookies; here we just accept anonymously
        // to prove the auth frame was sent and the handshake completed.
        return { userId: 'cookie-user' }
      },
    })

    try {
      const subscribed = deferred<void>()
      const invalidated = deferred<void>()
      const ws = createWsManager({
        url: `ws://localhost:${authServer.port}/api/ws`,
        requiresAuth: true, // no getToken — cookie auth pattern
        onSubscribed: (id) => {
          if (id === 'sub1') subscribed.resolve()
        },
      })
      ws.connect()

      ws.subscribe('sub1', 'listTodos', {}, () => invalidated.resolve())
      await withTimeout(subscribed.promise, 'timeout waiting for subscription')

      await fetch(`http://localhost:${authServer.port}/api/addTodo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Cookie authed' }),
      })

      await withTimeout(invalidated.promise, 'timeout waiting for invalidation')
      expect(ws.isConnected()).toBe(true)
      ws.disconnect()
    } finally {
      authServer.stop(true)
    }
  })

  test('createClient requiresAuth:false keeps WS no-auth even with getToken configured', async () => {
    let tokenCalls = 0
    const client = createClient({
      url: baseUrl,
      requiresAuth: false,
      getToken: () => {
        tokenCalls++
        throw new Error('WS no-auth path must not call getToken')
      },
    })

    client.ws.connect()

    const invalidated = new Promise<void>((resolve, reject) => {
      client.ws.subscribe('sub1', 'listTodos', {}, () => resolve())
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    await new Promise((r) => setTimeout(r, 200))
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Trusted local runtime' }),
    })

    await invalidated
    expect(tokenCalls).toBe(0)
    expect(client.ws.isConnected()).toBe(true)
    client.ws.disconnect()
  })

  test('does not reconnect on close code 4001', async () => {
    const app = await makeAuthApp()

    // Count auth attempts on the server. Each connection attempt runs
    // resolveContext once at handshake time (per Finding #1 fix).
    // No retries ⇒ count === 1. A reconnect loop ⇒ count > 1.
    let authAttempts = 0
    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (req) => {
        authAttempts++
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    try {
      const ws = createWsManager({
        url: `ws://localhost:${authServer.port}/api/ws`,
        getToken: () => null, // triggers server close 4001
      })
      ws.connect()

      // Wait well past the first reconnect window (~1-1.5s). If the client
      // were retrying, authAttempts would tick up every cycle.
      await new Promise((r) => setTimeout(r, 2500))

      expect(ws.isConnected()).toBe(false)
      expect(authAttempts).toBe(1) // exactly one connection attempt, no retry
      ws.disconnect()
    } finally {
      authServer.stop(true)
    }
  })

  test('re-subscribes on reconnect', async () => {
    let subscribedCount = 0
    const firstSubscribed = deferred<void>()
    const secondSubscribed = deferred<void>()
    const ws = createWsManager({
      url: wsUrl,
      onSubscribed: (id) => {
        if (id !== 'sub1') return
        subscribedCount++
        if (subscribedCount === 1) firstSubscribed.resolve()
        if (subscribedCount === 2) secondSubscribed.resolve()
      },
    })
    ws.connect()

    await waitForConnected(ws)

    let invalidateCount = 0
    const firstInvalidation = deferred<void>()
    const secondInvalidation = deferred<void>()
    ws.subscribe('sub1', 'listTodos', {}, () => {
      invalidateCount++
      if (invalidateCount === 1) firstInvalidation.resolve()
      if (invalidateCount === 2) secondInvalidation.resolve()
    })
    await withTimeout(firstSubscribed.promise, 'timeout waiting for subscription')

    // Trigger invalidation before disconnect
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Before reconnect' }),
    })

    await withTimeout(firstInvalidation.promise, 'timeout waiting for invalidation')
    expect(invalidateCount).toBe(1)

    // Force reconnect by disconnecting + reconnecting
    ws.disconnect()
    ws.connect()

    await waitForConnected(ws)
    await withTimeout(secondSubscribed.promise, 'timeout waiting for resubscription')

    // Trigger invalidation after reconnect
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'After reconnect' }),
    })

    await withTimeout(secondInvalidation.promise, 'timeout waiting for invalidation')
    expect(invalidateCount).toBe(2)

    ws.disconnect()
  })
})
