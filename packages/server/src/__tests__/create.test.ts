import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { definePermissions } from '@wystack/permissions'
import { defineApp, PermissionDeniedError } from '../index'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
})

interface AppContext {
  principal?: unknown
}

const permissions = definePermissions<{ principal?: unknown }>()({
  todos: {
    read: {
      description: 'Read todos',
      check: (ctx) => {
        const principal = ctx.principal
        return (
          typeof principal === 'object' &&
          principal !== null &&
          (('userId' in principal && principal.userId === 'user-1') ||
            ('credentialId' in principal && principal.credentialId === 'credential-1'))
        )
      },
    },
  },
})

const rolePermission = {
  id: 'roles.admin',
  description: 'Act as an administrator',
  check: (ctx: { role?: string }) => ctx.role === 'admin',
}

const throwingPermission = {
  id: 'checks.throw',
  description: 'Throw while checking',
  check: () => {
    throw new Error('permission check boom')
  },
}

const wy = defineApp<AppContext>({ permissions })
let app: Awaited<ReturnType<typeof wy.build>>

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

  app = await wy.build({
    db,
    functions: {
      listTodos: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.todos).all()),
      addTodo: wy.procedure.input({ title: text }).mutation(async (ctx, args) => {
        return ctx.db.into(schema.todos).insert({ title: args.title, done: false })
      }),
      addTwoInTx: wy.procedure.input({ a: text, b: text }).mutation(async (ctx, args) =>
        ctx.db.transaction(async (tx) => {
          await tx.into(schema.todos).insert({ title: args.a, done: false })
          await tx.into(schema.todos).insert({ title: args.b, done: false })
        }),
      ),
      addThenFail: wy.procedure.input({ title: text }).mutation(async (ctx, args) =>
        ctx.db.transaction(async (tx) => {
          await tx.into(schema.todos).insert({ title: args.title, done: false })
          throw new Error('handler boom')
        }),
      ),
      protectedListTodos: wy.procedure
        .authorize(permissions.todos.read)
        .input({})
        .query(async (ctx) => ctx.db.from(schema.todos).all()),
      canReadTodos: wy.procedure.input({}).query(async (ctx) => ctx.can(permissions.todos.read)),
      canAfterRoleDowngrade: wy.procedure
        .use(({ next }) => next({ role: 'viewer' }))
        .input({})
        .query(async (ctx) => ({ role: ctx.role, allowed: await ctx.can(rolePermission) })),
      canWithThrowingCheck: wy.procedure
        .input({})
        .query(async (ctx) => ctx.can(throwingPermission)),
    },
  })
})

describe('defineApp().build()', () => {
  test('registers functions', () => {
    expect(app.functions.has('listTodos')).toBe(true)
    expect(app.functions.has('addTodo')).toBe(true)
  })

  test('call() executes functions and tracks reads and writes', async () => {
    const queryResult = await app.call('listTodos', {})
    expect(queryResult.result).toEqual([])
    expect(queryResult.tablesRead.has('todos')).toBe(true)

    const mutationResult = await app.call('addTodo', { title: 'Test' })
    expect(mutationResult.result).toEqual([expect.objectContaining({ title: 'Test', done: false })])
    expect(mutationResult.tablesWritten.has('todos')).toBe(true)
  })

  test('call() throws for an unknown function', async () => {
    await expect(app.call('unknown', {})).rejects.toThrow('Unknown function: unknown')
  })

  test('authorize() denies malformed, absent, and ungranted principals', async () => {
    const denied = [
      {},
      { principal: null },
      { principal: { kind: 'user' } },
      { principal: { kind: 'robot', userId: 'user-1' } },
      { principal: { kind: 'user', userId: 'user-2' } },
    ]

    for (const context of denied) {
      await expect(app.call('protectedListTodos', {}, context)).rejects.toBeInstanceOf(
        PermissionDeniedError,
      )
    }
  })

  test('authorize() permits both granted principal kinds', async () => {
    for (const principal of [
      { kind: 'user', userId: 'user-1' },
      { kind: 'service', credentialId: 'credential-1' },
    ]) {
      const { result } = await app.call('protectedListTodos', {}, { principal })
      expect(result).toEqual([])
    }
  })

  test('ctx.can returns a boolean grant or denial through evaluate()', async () => {
    const denied = await app.call('canReadTodos', {})
    expect(denied.result).toBe(false)

    const granted = await app.call(
      'canReadTodos',
      {},
      {
        principal: { kind: 'user', userId: 'user-1' },
      },
    )
    expect(granted.result).toBe(true)
  })

  test('ctx.can evaluates the final middleware-composed context', async () => {
    const { result } = await app.call(
      'canAfterRoleDowngrade',
      {},
      {
        role: 'admin',
        principal: { kind: 'user', userId: 'user-1' },
      },
    )
    expect(result).toEqual({ role: 'viewer', allowed: false })
  })

  test('ctx.can propagates permission policy errors', async () => {
    await expect(
      app.call(
        'canWithThrowingCheck',
        {},
        {
          principal: { kind: 'user', userId: 'user-1' },
        },
      ),
    ).rejects.toThrow('permission check boom')
  })

  test('surfaces writes from commit and none from rollback', async () => {
    const committed = await app.call('addTwoInTx', { a: 'X', b: 'Y' })
    expect(committed.tablesWritten.has('todos')).toBe(true)

    await expect(app.call('addThenFail', { title: 'ghost' })).rejects.toThrow('handler boom')
    const { result } = await app.call('listTodos', {})
    expect(result as unknown[]).toHaveLength(2)
  })

  test('expectedPermissionIds rejects permission tree drift at boot', async () => {
    const pg = new PGlite()
    await expect(
      wy.build({
        db: drizzle(pg),
        functions: {},
        expectedPermissionIds: ['todos.manage'],
      }),
    ).rejects.toThrow('Permission ids differ from snapshot')
  })

  test('expectedPermissionIds accepts the canonical snapshot', async () => {
    const pg = new PGlite()
    await expect(
      wy.build({
        db: drizzle(pg),
        functions: {},
        expectedPermissionIds: ['todos.read'],
      }),
    ).resolves.toBeDefined()
  })
})
