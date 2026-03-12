/**
 * E2E Integration Test — proves the full vertical slice:
 * Schema DSL → TrackedDb → createWyStack → serve → WS subscribe → HTTP mutate → reactive update
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean, eq } from '@wystack/db'
import { createWyStack } from '../create'
import { query, mutation } from '../functions'
import { serve } from '../transport'

// 1. Define schema using DSL
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
  // 2. Create database + tracked db
  const pg = new PGlite()
  const db = drizzle(pg)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL
    )
  `)

  // 3. Create app with queries and mutations
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
      toggleTodo: mutation({
        args: { id: int },
        handler: async (ctx, args) => {
          return ctx.db
            .from(schema.todos)
            .where(eq('id', args.id))
            .update({ done: true })
        },
      }),
    },
  })

  // 4. Start server
  server = serve({ app, port: 0 })
  baseUrl = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

describe('E2E: full reactive lifecycle', () => {
  test('subscribe → mutate → receive reactive update → mutate again → receive second update', async () => {
    const wsUrl = `ws://localhost:${server.port}/wystack/ws`
    const ws = new WebSocket(wsUrl)

    const messages: any[] = []

    // 5. Subscribe via WebSocket
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', id: 'e2e-sub', path: 'listTodos', args: {} }))
      }
      ws.onmessage = (event) => {
        messages.push(JSON.parse(event.data))
        if (messages.length === 1) resolve()
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout waiting for initial data')), 5000)
    })

    // Verify initial empty result
    expect(messages[0].type).toBe('data')
    expect(messages[0].id).toBe('e2e-sub')
    expect(messages[0].data).toEqual([])

    // 6. Mutate via HTTP — add a todo
    const addRes = await fetch(`${baseUrl}/wystack/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Buy groceries' }),
    })
    const addJson = await addRes.json()
    expect(addJson.data).toHaveLength(1)
    expect(addJson.data[0].title).toBe('Buy groceries')
    const todoId = addJson.data[0].id

    // 7. Wait for reactive update via WebSocket
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (messages.length >= 2) return resolve()
        setTimeout(check, 50)
      }
      check()
      setTimeout(() => reject(new Error('timeout waiting for first reactive update')), 5000)
    })

    expect(messages[1].type).toBe('data')
    expect(messages[1].data).toHaveLength(1)
    expect(messages[1].data[0].title).toBe('Buy groceries')
    expect(messages[1].data[0].done).toBe(false)

    // 8. Mutate again — toggle the todo
    const toggleRes = await fetch(`${baseUrl}/wystack/toggleTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: todoId }),
    })
    const toggleJson = await toggleRes.json()
    expect(toggleJson.data[0].done).toBe(true)

    // 9. Wait for second reactive update
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (messages.length >= 3) return resolve()
        setTimeout(check, 50)
      }
      check()
      setTimeout(() => reject(new Error('timeout waiting for second reactive update')), 5000)
    })

    expect(messages[2].type).toBe('data')
    expect(messages[2].data).toHaveLength(1)
    expect(messages[2].data[0].done).toBe(true)

    ws.close()
  })
})
