import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack, query, mutation } from '@wystack/server'
import { serve } from '@wystack/server/bun'
import { createWsManager } from '../ws'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
})

let server: ReturnType<typeof serve>
let wsUrl: string
let baseUrl: string

beforeEach(async () => {
  const pg = new PGlite()
  const db = drizzle(pg)
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

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ws.isConnected()) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    expect(ws.isConnected()).toBe(true)
    ws.disconnect()
    expect(ws.isConnected()).toBe(false)
  })

  test('receives invalidation after mutation', async () => {
    const ws = createWsManager({ url: wsUrl })
    ws.connect()

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ws.isConnected()) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    // Subscribe — handler fires on invalidation only
    const invalidated = new Promise<void>((resolve, reject) => {
      ws.subscribe('sub1', 'listTodos', {}, () => resolve())
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    // Give server time to process subscription
    await new Promise((r) => setTimeout(r, 100))

    // Mutate via HTTP
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'From WS test' }),
    })

    await invalidated
    ws.disconnect()
  })

  test('unsubscribe stops receiving invalidations', async () => {
    const ws = createWsManager({ url: wsUrl })
    ws.connect()

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ws.isConnected()) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    let invalidateCount = 0
    ws.subscribe('sub1', 'listTodos', {}, () => {
      invalidateCount++
    })

    await new Promise((r) => setTimeout(r, 100))

    // First mutation — should trigger invalidation
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'First' }),
    })

    await new Promise((r) => setTimeout(r, 200))
    expect(invalidateCount).toBe(1)

    // Unsubscribe
    ws.unsubscribe('sub1')
    await new Promise((r) => setTimeout(r, 100))

    // Second mutation — should NOT trigger
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
    const pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(
      `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
    )

    const app = await createWyStack({
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
      const ws = createWsManager({
        url: `ws://localhost:${authServer.port}/api/ws`,
        getToken: () => 'user_123',
      })
      ws.connect()

      const invalidated = new Promise<void>((resolve, reject) => {
        // Call subscribe immediately — before WS even opens. Must not lose the sub.
        ws.subscribe('sub1', 'listTodos', {}, () => resolve())
        setTimeout(() => reject(new Error('timeout')), 5000)
      })

      // Trigger invalidation via HTTP mutation
      await new Promise((r) => setTimeout(r, 200))
      await fetch(`http://localhost:${authServer.port}/api/addTodo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer user_123',
        },
        body: JSON.stringify({ title: 'Authed' }),
      })

      await invalidated
      ws.disconnect()
    } finally {
      authServer.stop(true)
    }
  })

  test('does not reconnect on close code 4001', async () => {
    const pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(
      `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
    )

    const app = await createWyStack({
      db,
      functions: {
        listTodos: query({ args: {}, handler: async (_ctx) => [] }),
      },
    })

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
    const ws = createWsManager({ url: wsUrl })
    ws.connect()

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ws.isConnected()) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    let invalidateCount = 0
    ws.subscribe('sub1', 'listTodos', {}, () => {
      invalidateCount++
    })

    await new Promise((r) => setTimeout(r, 100))

    // Trigger invalidation before disconnect
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Before reconnect' }),
    })

    await new Promise((r) => setTimeout(r, 200))
    expect(invalidateCount).toBe(1)

    // Force reconnect by disconnecting + reconnecting
    ws.disconnect()
    ws.connect()

    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ws.isConnected()) {
          clearInterval(check)
          resolve()
        }
      }, 50)
    })

    // Give server time to process re-subscriptions
    await new Promise((r) => setTimeout(r, 200))

    // Trigger invalidation after reconnect
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'After reconnect' }),
    })

    await new Promise((r) => setTimeout(r, 200))
    expect(invalidateCount).toBe(2)

    ws.disconnect()
  })
})
