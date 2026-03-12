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

  const app = createWyStack({
    drizzle: db,
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
  wsUrl = `ws://localhost:${server.port}/wystack/ws`
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

    expect(result.type).toBe('data')
    expect(result.data).toEqual([])
    ws.disconnect()
  })

  test('receives updates after mutation', async () => {
    const ws = createWsManager(wsUrl)
    ws.connect()

    // First subscribe and get initial data
    const messages: any[] = []
    await new Promise<void>((resolve, reject) => {
      ws.subscribe('sub1', 'listTodos', {}, (msg) => {
        messages.push(msg)
        if (messages.length === 1) resolve()
      })
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    expect(messages[0].data).toEqual([])

    // Now mutate via HTTP
    const baseUrl = `http://localhost:${server.port}`
    await fetch(`${baseUrl}/wystack/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'From WS test' }),
    })

    // Wait for the reactive update
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (messages.length >= 2) return resolve()
        setTimeout(check, 50)
      }
      check()
      setTimeout(() => reject(new Error('timeout waiting for update')), 5000)
    })

    expect(messages[1].type).toBe('data')
    expect(messages[1].data).toHaveLength(1)
    expect(messages[1].data[0].title).toBe('From WS test')

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
