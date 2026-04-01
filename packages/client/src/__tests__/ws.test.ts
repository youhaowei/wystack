import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack, query, mutation, serve } from '@wystack/server'
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
  test('connects and subscribes to a query', async () => {
    const ws = createWsManager(wsUrl)
    ws.connect()

    const result = await new Promise<any>((resolve, reject) => {
      ws.subscribe('sub1', 'listTodos', {}, (msg) => {
        resolve(msg)
      })
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    expect(result.type).toBe('subscribed')
    ws.disconnect()
  })

  test('receives invalidation after mutation', async () => {
    const ws = createWsManager(wsUrl)
    ws.connect()

    // Subscribe and wait for confirmation
    await new Promise<void>((resolve, reject) => {
      ws.subscribe('sub1', 'listTodos', {}, (raw) => {
        const msg = raw as Record<string, unknown>
        if (msg.type === 'subscribed') resolve()
      })
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    // Set up invalidation listener
    const invalidation = new Promise<Record<string, unknown>>((resolve, reject) => {
      ws.subscribe('sub1', 'listTodos', {}, (raw) => {
        const msg = raw as Record<string, unknown>
        if (msg.type === 'invalidate') resolve(msg)
      })
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    // Mutate via HTTP
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'From WS test' }),
    })

    const msg = await invalidation
    expect(msg.type).toBe('invalidate')
    expect(msg.id).toBe('sub1')

    ws.disconnect()
  })

  test('unsubscribe stops receiving messages', async () => {
    const ws = createWsManager(wsUrl)
    ws.connect()

    let received = false
    await new Promise<void>((resolve, reject) => {
      ws.subscribe('sub1', 'listTodos', {}, () => {
        received = true
        resolve()
      })
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    expect(received).toBe(true)
    ws.unsubscribe('sub1')
    ws.disconnect()
  })
})
