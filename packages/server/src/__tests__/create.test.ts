import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack } from '../create'
import { PermissionDeniedError } from '../permissions'
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
    checkPermission: async (principal, permission) =>
      permission === 'todos.read' &&
      ((principal.kind === 'user' && principal.userId === 'user-1') ||
        (principal.kind === 'service' && principal.credentialId === 'cred-1')),
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
      addTwoInTx: mutation({
        args: { a: text, b: text },
        handler: async (ctx, args) =>
          ctx.db.transaction(async (tx) => {
            await tx.into(schema.todos).insert({ title: args.a, done: false })
            await tx.into(schema.todos).insert({ title: args.b, done: false })
          }),
      }),
      addThenFail: mutation({
        args: { title: text },
        handler: async (ctx, args) =>
          ctx.db.transaction(async (tx) => {
            await tx.into(schema.todos).insert({ title: args.title, done: false })
            throw new Error('handler boom')
          }),
      }),
      protectedListTodos: query({
        permission: 'todos.read',
        args: {},
        handler: async (ctx) => ctx.db.from(schema.todos).all(),
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
    const rows = result as { title: string }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Test')
    expect(tablesWritten.has('todos')).toBe(true)
  })

  test('call() throws for unknown function', async () => {
    expect(app.call('unknown', {})).rejects.toThrow('Unknown function: unknown')
  })

  test('call() enforces a function permission before dispatch', async () => {
    await expect(app.call('protectedListTodos', {})).rejects.toBeInstanceOf(PermissionDeniedError)

    const { result } = await app.call(
      'protectedListTodos',
      {},
      {
        principal: { kind: 'user', userId: 'user-1' },
      },
    )
    expect(result).toEqual([])

    await expect(
      app.call('protectedListTodos', {}, { principal: { kind: 'user', userId: 'user-2' } }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  // Enforcement reads context.principal and nothing else. Every way that read
  // can come up short is a deny, not a fallback — these pin that shut.
  test('call() denies when the context carries no principal', async () => {
    await expect(app.call('protectedListTodos', {}, {})).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
  })

  test('call() denies a principal with an unrecognized kind', async () => {
    await expect(
      app.call('protectedListTodos', {}, { principal: { kind: 'robot', userId: 'user-1' } }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  // The service kind exists so non-human callers have somewhere to live, so it
  // needs a positive case: without one, a regression that made the service
  // branch of isPrincipal always deny would pass every negative test below.
  test('call() authorizes a well-formed service principal', async () => {
    const { result } = await app.call(
      'protectedListTodos',
      {},
      { principal: { kind: 'service', credentialId: 'cred-1' } },
    )
    expect(result).toEqual([])
  })

  test('call() denies a service principal the check does not grant', async () => {
    await expect(
      app.call(
        'protectedListTodos',
        {},
        { principal: { kind: 'service', credentialId: 'cred-2' } },
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  // A recognized kind alone is not a principal. The identifier is what the
  // application's checkPermission keys off, so a principal missing it must
  // never reach the hook — an app that grants by kind would authorize nobody.
  test('call() denies a principal whose kind is recognized but whose identifier is missing', async () => {
    const malformed = [
      { kind: 'user' },
      { kind: 'user', userId: '' },
      { kind: 'user', userId: 42 },
      { kind: 'service' },
      { kind: 'service', credentialId: '' },
      { kind: 'service', credentialId: null },
    ]

    for (const principal of malformed) {
      await expect(app.call('protectedListTodos', {}, { principal })).rejects.toBeInstanceOf(
        PermissionDeniedError,
      )
    }
  })

  test('call() denies a bare userId context — a userId is not a principal', async () => {
    await expect(app.call('protectedListTodos', {}, { userId: 'user-1' })).rejects.toBeInstanceOf(
      PermissionDeniedError,
    )
  })

  // The hook is application-supplied and reaches the boundary from untyped
  // JavaScript too, so only an explicit `true` grants. A truthy sentinel
  // returned by mistake must not read as an allow.
  test('call() denies a truthy non-boolean checkPermission result', async () => {
    for (const truthy of ['yes', 1, {}, [], { allowed: true }]) {
      const pg = new PGlite()
      const sloppy = await createWyStack({
        db: drizzle(pg),
        checkPermission: (async () => truthy) as unknown as Parameters<
          typeof createWyStack
        >[0]['checkPermission'],
        functions: {
          protectedListTodos: query({
            permission: 'todos.read',
            args: {},
            handler: async () => [],
          }),
        },
      })

      await expect(
        sloppy.call('protectedListTodos', {}, { principal: { kind: 'user', userId: 'user-1' } }),
      ).rejects.toBeInstanceOf(PermissionDeniedError)
    }
  })

  test('call() denies when checkPermission is unwired', async () => {
    const pg = new PGlite()
    const db = drizzle(pg)
    const unguarded = await createWyStack({
      db,
      functions: {
        protectedListTodos: query({
          permission: 'todos.read',
          args: {},
          handler: async () => [],
        }),
      },
    })

    await expect(
      unguarded.call('protectedListTodos', {}, { principal: { kind: 'user', userId: 'user-1' } }),
    ).rejects.toBeInstanceOf(PermissionDeniedError)
  })

  test('call() surfaces tablesWritten from a committed tracked transaction', async () => {
    const { tablesWritten } = await app.call('addTwoInTx', { a: 'X', b: 'Y' })
    // The transaction's write Tags must reach the call-scope set, or
    // invalidateSubscriptions never fires for a committed batch.
    expect(tablesWritten.has('todos')).toBe(true)

    const { result } = await app.call('listTodos', {})
    expect(result as unknown[]).toHaveLength(2)
  })

  test('call() surfaces no tablesWritten when a tracked transaction rolls back', async () => {
    await expect(app.call('addThenFail', { title: 'ghost' })).rejects.toThrow('handler boom')

    // Fresh call: the rolled-back write neither persisted nor emitted a Tag.
    const { result } = await app.call('listTodos', {})
    expect(result as unknown[]).toHaveLength(0)
  })
})
