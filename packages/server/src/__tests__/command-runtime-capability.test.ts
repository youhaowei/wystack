import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { defineSchema, int, syncSchema, table, text } from '@wystack/db'
import { drizzle } from 'drizzle-orm/pglite'
import { createDraftLifecycle } from '../draft-lifecycle'
import { defineApp } from '../define-app'

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
  app = await wy.build({
    db,
    functions: {
      inspectCommandDb: wy.procedure.input({}).command(async (ctx) => {
        const surface = ctx.db as unknown as Record<string, unknown>
        return {
          transaction: typeof surface['transaction'] === 'function',
          frozen: Object.isFrozen(ctx.db),
        }
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
})
