/**
 * E2E Integration Test — proves the full vertical slice:
 * Schema DSL → TrackedDb → createWyStack → serve → WS subscribe → HTTP mutate → invalidation
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean, eq } from '@wystack/db'
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

  server = serve({ app, port: 0 })
  baseUrl = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

describe('E2E: full reactive lifecycle', () => {
  test('subscribe → mutate → receive invalidation → refetch → mutate again → second invalidation', async () => {
    const wsUrl = `ws://localhost:${server.port}/api/ws`
    const ws = new WebSocket(wsUrl)

    // 1. Subscribe via WebSocket
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', id: 'e2e-sub', path: 'listTodos', args: {} }))
      }
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'subscribed') resolve()
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    // 2. Verify initial state via HTTP GET
    const initialRes = await fetch(`${baseUrl}/api/listTodos`)
    const initialJson = await initialRes.json()
    expect(initialJson.data).toEqual([])

    // 3. Mutate via HTTP POST — add a todo
    const invalidation1 = new Promise<any>((resolve, reject) => {
      ws.onmessage = (event) => resolve(JSON.parse(event.data))
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    const addRes = await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Buy groceries' }),
    })
    const addJson = await addRes.json()
    expect(addJson.data).toHaveLength(1)
    expect(addJson.data[0].title).toBe('Buy groceries')
    const todoId = addJson.data[0].id

    // 4. Receive invalidation signal via WS
    const inv1 = await invalidation1
    expect(inv1.type).toBe('invalidate')
    expect(inv1.id).toBe('e2e-sub')

    // 5. Refetch via HTTP GET (like React Query would)
    const refetch1 = await fetch(`${baseUrl}/api/listTodos`)
    const refetch1Json = await refetch1.json()
    expect(refetch1Json.data).toHaveLength(1)
    expect(refetch1Json.data[0].title).toBe('Buy groceries')
    expect(refetch1Json.data[0].done).toBe(false)

    // 6. Mutate again — toggle the todo
    const invalidation2 = new Promise<any>((resolve, reject) => {
      ws.onmessage = (event) => resolve(JSON.parse(event.data))
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    await fetch(`${baseUrl}/api/toggleTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: todoId }),
    })

    // 7. Receive second invalidation
    const inv2 = await invalidation2
    expect(inv2.type).toBe('invalidate')
    expect(inv2.id).toBe('e2e-sub')

    // 8. Refetch shows updated data
    const refetch2 = await fetch(`${baseUrl}/api/listTodos`)
    const refetch2Json = await refetch2.json()
    expect(refetch2Json.data).toHaveLength(1)
    expect(refetch2Json.data[0].done).toBe(true)

    ws.close()
  })

  test('context passed through to handlers', async () => {
    const pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(`CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`)

    const app = await createWyStack({
      db,
      functions: {
        getContext: query({
          args: {},
          handler: async (ctx) => ({ orgId: ctx.orgId, userId: ctx.userId }),
        }),
      },
    })

    const authServer = serve({
      app,
      port: 0,
      resolveContext: async () => {
        return { orgId: 'org_abc', userId: 'usr_123' }
      },
    })

    try {
      const res = await fetch(`http://localhost:${authServer.port}/api/getContext`)
      const json = await res.json()
      expect(json.data.orgId).toBe('org_abc')
      expect(json.data.userId).toBe('usr_123')
    } finally {
      authServer.stop(true)
    }
  })
})
