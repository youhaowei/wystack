import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack } from '../create'
import { query, mutation } from '../functions'
import { serve } from '../transport'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
})

let server: ReturnType<typeof serve>
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
  baseUrl = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

describe('HTTP transport', () => {
  test('GET /wystack/listTodos returns empty array', async () => {
    const res = await fetch(`${baseUrl}/wystack/listTodos`)
    const json = await res.json()
    expect(json.data).toEqual([])
  })

  test('POST /wystack/addTodo creates a todo', async () => {
    const res = await fetch(`${baseUrl}/wystack/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test todo' }),
    })
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].title).toBe('Test todo')
  })

  test('POST /wystack/unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/wystack/unknown`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('GET / returns 404', async () => {
    const res = await fetch(baseUrl)
    expect(res.status).toBe(404)
  })

  test('GET query with args', async () => {
    await fetch(`${baseUrl}/wystack/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello' }),
    })

    const res = await fetch(`${baseUrl}/wystack/listTodos`)
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].title).toBe('Hello')
  })

  test('resolveContext is called per request', async () => {
    const pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(`CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`)

    const app = await createWyStack({
      db,
      functions: {
        whoami: query({
          args: {},
          handler: async (ctx) => ({ userId: ctx.userId }),
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
      // Without token → 401
      const noAuth = await fetch(`http://localhost:${authServer.port}/wystack/whoami`)
      expect(noAuth.status).toBe(401)

      // With token → context passed through
      const withAuth = await fetch(`http://localhost:${authServer.port}/wystack/whoami`, {
        headers: { Authorization: 'Bearer user_123' },
      })
      const json = await withAuth.json()
      expect(json.data.userId).toBe('user_123')
    } finally {
      authServer.stop(true)
    }
  })
})

describe('WebSocket transport', () => {
  test('subscribe returns confirmation', async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/wystack/ws`)

    const result = await new Promise<any>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'listTodos', args: {} }))
      }
      ws.onmessage = (event) => {
        resolve(JSON.parse(event.data))
        ws.close()
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    expect(result.type).toBe('subscribed')
    expect(result.id).toBe('sub1')
  })

  test('mutation sends invalidation signal to subscriber', async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/wystack/ws`)

    // Subscribe first
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'listTodos', args: {} }))
      }
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'subscribed') resolve()
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    // Mutate via HTTP
    const invalidation = new Promise<any>((resolve, reject) => {
      ws.onmessage = (event) => resolve(JSON.parse(event.data))
      setTimeout(() => reject(new Error('timeout waiting for invalidation')), 5000)
    })

    await fetch(`${baseUrl}/wystack/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'triggers invalidation' }),
    })

    const msg = await invalidation
    expect(msg.type).toBe('invalidate')
    expect(msg.id).toBe('sub1')

    ws.close()
  })

  test('subscribe to unknown query returns error', async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/wystack/ws`)

    const result = await new Promise<any>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'nonexistent', args: {} }))
      }
      ws.onmessage = (event) => {
        resolve(JSON.parse(event.data))
        ws.close()
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    expect(result.type).toBe('error')
  })

  test('WS with resolveContext rejects unauthenticated', async () => {
    const pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(`CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`)

    const app = await createWyStack({
      db,
      functions: {
        listTodos: query({ args: {}, handler: async (ctx) => [] }),
      },
    })

    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (req) => {
        const token = new URL(req.url).searchParams.get('token')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    try {
      // Without token → HTTP 401 on upgrade
      const res = await fetch(`http://localhost:${authServer.port}/wystack/ws`)
      expect(res.status).toBe(401)
    } finally {
      authServer.stop(true)
    }
  })
})
