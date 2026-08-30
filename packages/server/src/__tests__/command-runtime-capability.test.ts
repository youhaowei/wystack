import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { createDrizzleTracker, defineSchema, int, syncSchema, table, text } from '@wystack/db'
import { drizzle } from 'drizzle-orm/pglite'
import { createDraftLifecycle } from '../draft-lifecycle'
import { defineApp } from '../define-app'
import { stageOkBrand, type MiddlewareFn } from '../types'

const schema = defineSchema({
  commandCapabilityTodos: table({ id: int.primaryKey(), title: text }).draftable(),
})
const wy = defineApp<Record<string, unknown>>({ permissions: {} })
let pg: PGlite
let app: Awaited<ReturnType<typeof wy.build>>

beforeEach(async () => {
  pg = new PGlite()
  const db = drizzle(pg)
  await syncSchema(db, schema)
  const escapedTracker = createDrizzleTracker(db)
  const replaceCommandDb = (() => ({
    [stageOkBrand]: true,
    patch: { db: escapedTracker },
  })) as unknown as MiddlewareFn<Record<string, unknown>, { db: typeof escapedTracker }>
  app = await wy.build({
    db,
    functions: {
      listCommandTodos: wy.procedure
        .input({})
        .query(async (ctx) => ctx.db.from(schema.commandCapabilityTodos).all()),
      inspectCommandDb: wy.procedure.input({}).command(async (ctx) => {
        const surface = ctx.db as unknown as Record<string, unknown>
        return {
          transaction: typeof surface['transaction'] === 'function',
          frozen: Object.isFrozen(ctx.db),
        }
      }),
      writeThenFail: wy.procedure.input({}).command(async (ctx) => {
        await ctx.db.into(schema.commandCapabilityTodos).insert({ id: 1, title: 'first' })
        await ctx.db.into(schema.commandCapabilityTodos).insert({ id: 1, title: 'duplicate' })
      }),
      middlewareDbEscape: wy.procedure
        .use(replaceCommandDb)
        .input({})
        .command(async (ctx) => {
          await ctx.db.into(schema.commandCapabilityTodos).insert({ id: 2, title: 'escaped' })
        }),
    },
  })
})

afterEach(async () => {
  await pg.close()
})

describe('replay-safe command runtime capability', () => {
  test('omits transaction in canonical and draft dispatch', async () => {
    expect((await app.call('inspectCommandDb', {})).result).toEqual({
      transaction: false,
      frozen: true,
    })

    const lifecycle = createDraftLifecycle(app, {
      resolveOwner: () => 'command-capability-owner',
      authorizeGlobalDraft: () => true,
    })
    const { results } = await lifecycle.openWithCommands(0, [
      { id: 'draft-dispatch', path: 'inspectCommandDb', args: {} },
    ])
    expect(results).toEqual([
      {
        id: 'draft-dispatch',
        value: { transaction: false, frozen: true },
      },
    ])
  })

  test('rolls back all writes when direct command dispatch fails', async () => {
    await expect(app.call('writeThenFail', {})).rejects.toThrow()

    expect((await app.call('listCommandTodos', {})).result).toEqual([])
  })

  test('rejects middleware attempts to replace CommandDb before direct or draft writes', async () => {
    await expect(app.call('middlewareDbEscape', {})).rejects.toThrow(
      'Middleware cannot override framework context property "db"',
    )

    const lifecycle = createDraftLifecycle(app, {
      resolveOwner: () => 'command-capability-owner',
      authorizeGlobalDraft: () => true,
    })
    const draftId = await lifecycle.open(0)
    await expect(
      lifecycle.append(draftId, [{ path: 'middlewareDbEscape', args: {} }]),
    ).rejects.toThrow('Middleware cannot override framework context property "db"')
    await lifecycle.discard(draftId)

    expect((await app.call('listCommandTodos', {})).result).toEqual([])
  })
})
