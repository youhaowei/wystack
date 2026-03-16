import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack } from '../create'
import { query, mutation } from '../functions'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
})

let app: Awaited<ReturnType<typeof createWyStack>>

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

  app = await createWyStack({
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
})

describe('createWyStack', () => {
  test('registers functions', () => {
    expect(app.functions.has('listTodos')).toBe(true)
    expect(app.functions.has('addTodo')).toBe(true)
  })

  test('call() executes a query and tracks reads', async () => {
    const { result, tablesRead } = await app.call('listTodos', {})
    expect(Array.isArray(result)).toBe(true)
    expect(tablesRead.has('todos')).toBe(true)
  })

  test('call() executes a mutation and tracks writes', async () => {
    const { result, tablesWritten } = await app.call('addTodo', { title: 'Test' })
    expect(result).toHaveLength(1)
    expect(result[0].title).toBe('Test')
    expect(tablesWritten.has('todos')).toBe(true)
  })

  test('call() throws for unknown function', async () => {
    expect(app.call('unknown', {})).rejects.toThrow('Unknown function: unknown')
  })
})
