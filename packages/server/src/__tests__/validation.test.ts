import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean, uuid, timestamp, jsonb } from '@wystack/db'
import { createWyStack } from '../create'
import { query, mutation } from '../functions'
import { buildArgsSchema, ValidationError } from '../validation'

// --- Unit tests: buildArgsSchema ---

describe('buildArgsSchema', () => {
  test('validates required text arg', () => {
    const schema = buildArgsSchema({ name: text })
    expect(schema.safeParse({ name: 'hello' }).success).toBe(true)
    expect(schema.safeParse({ name: 42 }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })

  test('validates required int arg', () => {
    const schema = buildArgsSchema({ count: int })
    expect(schema.safeParse({ count: 5 }).success).toBe(true)
    expect(schema.safeParse({ count: 3.14 }).success).toBe(false)
    expect(schema.safeParse({ count: 'five' }).success).toBe(false)
  })

  test('validates required boolean arg', () => {
    const schema = buildArgsSchema({ done: boolean })
    expect(schema.safeParse({ done: true }).success).toBe(true)
    expect(schema.safeParse({ done: 'yes' }).success).toBe(false)
  })

  test('validates uuid arg', () => {
    const schema = buildArgsSchema({ id: uuid })
    expect(schema.safeParse({ id: '550e8400-e29b-41d4-a716-446655440000' }).success).toBe(true)
    expect(schema.safeParse({ id: 'not-a-uuid' }).success).toBe(false)
  })

  test('validates timestamp arg with coercion', () => {
    const schema = buildArgsSchema({ at: timestamp })
    expect(schema.safeParse({ at: '2024-01-01T00:00:00Z' }).success).toBe(true)
    expect(schema.safeParse({ at: new Date() }).success).toBe(true)
    expect(schema.safeParse({ at: 'not-a-date' }).success).toBe(false)
  })

  test('allows any value for jsonb arg', () => {
    const schema = buildArgsSchema({ data: jsonb })
    expect(schema.safeParse({ data: { nested: [1, 2, 3] } }).success).toBe(true)
    expect(schema.safeParse({ data: null }).success).toBe(true)
    expect(schema.safeParse({ data: 'string' }).success).toBe(true)
  })

  test('handles optional args', () => {
    const schema = buildArgsSchema({ name: text.optional() })
    expect(schema.safeParse({ name: 'hello' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ name: undefined }).success).toBe(true)
    expect(schema.safeParse({ name: 42 }).success).toBe(false)
  })

  test('handles args with defaults as optional and applies default value', () => {
    const schema = buildArgsSchema({ limit: int.default(10) })
    expect(schema.safeParse({ limit: 5 }).success).toBe(true)
    const result = schema.safeParse({})
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ limit: 10 })
  })

  test('handles array args', () => {
    const schema = buildArgsSchema({ tags: text.array() })
    expect(schema.safeParse({ tags: ['a', 'b'] }).success).toBe(true)
    expect(schema.safeParse({ tags: [] }).success).toBe(true)
    expect(schema.safeParse({ tags: [1, 2] }).success).toBe(false)
    expect(schema.safeParse({ tags: 'single' }).success).toBe(false)
  })

  test('handles empty args descriptor', () => {
    const schema = buildArgsSchema({})
    expect(schema.safeParse({}).success).toBe(true)
  })

  test('strips unknown fields', () => {
    const schema = buildArgsSchema({ name: text })
    const result = schema.safeParse({ name: 'hello', extra: 'ignored' })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ name: 'hello' })
  })

  test('handles multiple args', () => {
    const schema = buildArgsSchema({ id: int, title: text, done: boolean.optional() })
    expect(schema.safeParse({ id: 1, title: 'Task' }).success).toBe(true)
    expect(schema.safeParse({ id: 1, title: 'Task', done: true }).success).toBe(true)
    expect(schema.safeParse({ id: 1 }).success).toBe(false) // missing title
  })
})

// --- Integration tests: validation in call() ---

describe('validation in call()', () => {
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
        getTodo: query({
          args: { id: int },
          handler: async (ctx, args) => ({ id: args.id }),
        }),
        addTodo: mutation({
          args: { title: text },
          handler: async (ctx, args) => {
            return ctx.db.into(schema.todos).insert({ title: args.title, done: false })
          },
        }),
        searchTodos: query({
          args: { query: text.optional(), limit: int.default(10) },
          handler: async (_ctx, _args) => [],
        }),
      },
    })
  })

  test('passes valid args through to handler', async () => {
    const { result } = await app.call('getTodo', { id: 42 })
    expect(result).toEqual({ id: 42 })
  })

  test('rejects wrong type for required arg', async () => {
    await expect(app.call('getTodo', { id: 'not-a-number' })).rejects.toThrow(ValidationError)
  })

  test('rejects missing required arg', async () => {
    await expect(app.call('addTodo', {})).rejects.toThrow(ValidationError)
  })

  test('allows empty args for functions with no args', async () => {
    const { result } = await app.call('listTodos', {})
    expect(Array.isArray(result)).toBe(true)
  })

  test('allows omitted optional args', async () => {
    const { result } = await app.call('searchTodos', {})
    expect(Array.isArray(result)).toBe(true)
  })

  test('allows omitted args with defaults', async () => {
    const { result } = await app.call('searchTodos', { query: 'test' })
    expect(Array.isArray(result)).toBe(true)
  })

  test('strips unknown fields from args', async () => {
    const { result } = await app.call('getTodo', { id: 1, extra: 'should be stripped' })
    expect(result).toEqual({ id: 1 })
  })

  test('ValidationError has structured issues', async () => {
    try {
      await app.call('addTodo', { title: 123 })
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError)
      const ve = err as ValidationError
      expect(ve.issues.length).toBeGreaterThan(0)
      expect(ve.issues[0].path).toBeDefined()
      expect(ve.message).toContain('Validation failed')
    }
  })
})
