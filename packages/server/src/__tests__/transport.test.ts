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
  baseUrl = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

describe('HTTP transport', () => {
  test('POST /wystack/listTodos returns empty array', async () => {
    const res = await fetch(`${baseUrl}/wystack/listTodos`, { method: 'POST' })
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

  test('mutation then query shows data', async () => {
    await fetch(`${baseUrl}/wystack/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello' }),
    })

    const res = await fetch(`${baseUrl}/wystack/listTodos`, { method: 'POST' })
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].title).toBe('Hello')
  })
})

describe('WebSocket transport', () => {
  test('subscribe receives initial data', async () => {
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

    expect(result.type).toBe('data')
    expect(result.id).toBe('sub1')
    expect(result.data).toEqual([])
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
})
