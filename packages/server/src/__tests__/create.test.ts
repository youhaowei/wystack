import { describe, test, expect, beforeEach } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createTestPg, useTestPglite } from '@wystack/db/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { table, defineSchema, text, int, boolean, eq, multiTenant } from '@wystack/db'
import { definePermissions } from '@wystack/permissions'
import { assertPermissionIds, defineApp, PermissionDeniedError } from '../index'

useTestPglite()

const schema = defineSchema({
  todos: table({
    id: int.primaryKey(),
    title: text,
    done: boolean,
  }),
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
function createTestDatabase(): PGlite {
  return createTestPg()
}

beforeEach(async () => {
  const pg = createTestDatabase()
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
      actionWriteThenFail: wy.procedure.input({ title: text }).action(async (ctx, args) => {
        await ctx.db.into(schema.todos).insert({ title: args.title, done: false })
        throw new Error('external step failed')
      }),
      actionFailedWrite: wy.procedure.input({}).action(async (ctx) => {
        await ctx.db.into(schema.todos).insert({ id: 1, title: 'duplicate', done: false })
      }),
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
      inspectDbSurface: wy.procedure.input({}).query(async (ctx) => {
        const dbSurface = ctx.db as unknown as Record<string, unknown>
        const selectSurface = ctx.db.from(schema.todos) as unknown as Record<string, unknown>
        const chainedSurface = ctx.db.from(schema.todos).where(eq('id', 1)) as unknown as Record<
          string,
          unknown
        >
        const insertSurface = ctx.db.into(schema.todos) as unknown as Record<string, unknown>
        return {
          raw: 'raw' in dbSurface,
          withTenant: 'withTenant' in dbSurface,
          withDraft: 'withDraft' in dbSurface,
          tablesRead: 'tablesRead' in dbSurface,
          tablesWritten: 'tablesWritten' in dbSurface,
          transaction: typeof dbSurface['transaction'] === 'function',
          builderDb: '_db' in selectSurface,
          builderTracker: '_tracker' in selectSurface,
          chainedDb: '_db' in chainedSurface,
          insertDb: '_db' in insertSurface,
        }
      }),
    },
  })
})

describe('defineApp().build()', () => {
  /** Tenant-aware applications must provide both the trusted descriptor and its request resolver. */
  test('requires tenancy and tenant resolution to be configured together', async () => {
    const pg = createTestDatabase()
    const isolatedDb = drizzle(pg)

    await expect(
      wy.build({
        db: isolatedDb,
        functions: {},
        resolveTenant: () => 'tenant-1',
      }),
    ).rejects.toThrow('requires tenancy and resolveTenant together')
    await expect(
      wy.build({
        db: isolatedDb,
        functions: {},
        tenancy: multiTenant({
          key: { property: 'tenantId', column: 'tenant_id', type: text },
        }),
      }),
    ).rejects.toThrow('requires tenancy and resolveTenant together')
  })

  /** Building an application performs no schema DDL, so a migrated runtime role needs only data access. */
  test('does not require application runtime roles to execute framework DDL at startup', async () => {
    const frameworkTables = await app.system.createTracked().raw.execute(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name = 'wystack_row_revisions'`,
    )

    expect(frameworkTables.rows).toEqual([])
  })

  test('registers functions', () => {
    expect(app.functions.has('listTodos')).toBe(true)
    expect(app.functions.has('addTodo')).toBe(true)
  })

  test('keeps privileged tracker custody behind one frozen system capability', () => {
    const root = app as unknown as Record<string, unknown>

    expect(root['createTracked']).toBeUndefined()
    expect(root['runHandler']).toBeUndefined()
    expect(root['scopeTracked']).toBeUndefined()
    expect(root['emit']).toBeUndefined()
    expect(Object.keys(app.system).sort()).toEqual([
      'createTracked',
      'emit',
      'resolvesTenant',
      'runHandler',
      'scopeTracked',
    ])
    expect(Object.isFrozen(app.system)).toBe(true)
  })

  test('keeps raw SQL, scope changes, and tracking state out of procedure custody', async () => {
    const { result } = await app.call('inspectDbSurface', {})
    expect(result).toEqual({
      raw: false,
      withTenant: false,
      withDraft: false,
      tablesRead: false,
      tablesWritten: false,
      transaction: true,
      builderDb: false,
      builderTracker: false,
      chainedDb: false,
      insertDb: false,
    })
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

  test('Action emits invalidation for a committed tracked write even if later external work fails', async () => {
    const invalidations: Set<string>[] = []
    const unsubscribe = app.invalidationSource.onInvalidation((tables) => {
      invalidations.push(new Set(tables))
    })

    await expect(app.call('actionWriteThenFail', { title: 'durable' })).rejects.toThrow(
      'external step failed',
    )
    expect(invalidations).toHaveLength(1)
    expect(invalidations[0]?.has('todos')).toBe(true)
    unsubscribe()
  })

  test('Action does not emit invalidation for a failed write', async () => {
    await app.call('addTodo', { title: 'existing' })
    const invalidations: Set<string>[] = []
    const unsubscribe = app.invalidationSource.onInvalidation((tables) => {
      invalidations.push(new Set(tables))
    })

    await expect(app.call('actionFailedWrite', {})).rejects.toThrow()
    expect(invalidations).toEqual([])
    unsubscribe()
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
    const pg = createTestDatabase()
    await expect(
      wy.build({
        db: drizzle(pg),
        functions: {},
        expectedPermissionIds: ['todos.manage'],
      }),
    ).rejects.toThrow('Permission ids differ from snapshot')
  })

  test('expectedPermissionIds accepts the canonical snapshot', async () => {
    const pg = createTestDatabase()
    await expect(
      wy.build({
        db: drizzle(pg),
        functions: {},
        expectedPermissionIds: ['todos.read'],
      }),
    ).resolves.toBeDefined()
  })

  test('permission id collection tolerates cycles and repeated tree references', () => {
    const circular: Record<string, unknown> = { permissions, alias: permissions }
    circular.self = circular

    expect(() => assertPermissionIds(circular, ['todos.read'])).not.toThrow()
  })
})
