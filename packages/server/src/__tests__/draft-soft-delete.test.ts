import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { defineSchema, eq, int, syncSchema, table, text, timestamp } from '@wystack/db'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { createDraftLifecycle } from '../draft-lifecycle'
import { defineApp } from '../define-app'
import { refreshStoredDraftIntegrity } from '../draft-store'

const schema = defineSchema({
  archivedTodos: table({
    id: int.primaryKey(),
    title: text,
    deletedAt: timestamp.nullable(),
    revision: int,
  })
    .softDelete('deletedAt')
    .revision('revision')
    .draftable(),
})
const wy = defineApp<Record<string, unknown>>({ permissions: {} })
let pg: PGlite
let db: ReturnType<typeof drizzle>
let app: Awaited<ReturnType<typeof wy.build>>

function lifecycle() {
  return createDraftLifecycle(app, {
    resolveOwner: () => 'soft-delete-owner',
    authorizeGlobalDraft: () => true,
  })
}

beforeEach(async () => {
  pg = new PGlite()
  db = drizzle(pg)
  await syncSchema(db, schema)
  await db.execute(
    `INSERT INTO "archivedTodos" (id,title,"deletedAt",revision)
     VALUES (1,'archive me',NULL,1)`,
  )
  app = await wy.build({
    db,
    functions: {
      listActive: wy.procedure
        .input({})
        .query(async (ctx) => ctx.db.from(schema.archivedTodos).all()),
      listAll: wy.procedure
        .input({})
        .query(async (ctx) => ctx.db.from(schema.archivedTodos).includeDeleted().all()),
      softDeleteTodo: wy.procedure
        .input({ id: int, at: timestamp })
        .command(async (ctx, args) =>
          ctx.db.from(schema.archivedTodos).where(eq('id', args.id)).softDelete(args.at),
        ),
      restoreTodo: wy.procedure
        .input({ id: int })
        .command(async (ctx, args) =>
          ctx.db.from(schema.archivedTodos).where(eq('id', args.id)).restore(),
        ),
    },
  })
})

afterEach(async () => {
  await pg.close()
})

describe('draft lifecycle — framework soft deletion', () => {
  test('publishes a tombstone without hiding canonical data before approval', async () => {
    const removedAt = new Date('2026-08-29T14:00:00.000Z')
    const drafts = lifecycle()
    const draftId = await drafts.open(0)

    await drafts.append(draftId, [{ path: 'softDeleteTodo', args: { id: 1, at: removedAt } }])

    expect((await app.call('listActive', {})).result).toHaveLength(1)
    const effective = app.system.createTracked().withDraft(draftId)
    expect(await effective.from(schema.archivedTodos).where(eq('id', 1)).first()).toBeNull()
    expect(
      await effective.from(schema.archivedTodos).onlyDeleted().where(eq('id', 1)).first(),
    ).toMatchObject({ deletedAt: removedAt, revision: 2 })
    expect(await drafts.inspect(draftId)).toMatchObject([
      {
        operation: 'update',
        fields: {
          deletedAt: { value: { kind: 'value', value: removedAt.toISOString() } },
        },
      },
    ])

    await drafts.publish(draftId)

    expect((await app.call('listActive', {})).result).toEqual([])
    expect((await app.call('listAll', {})).result).toMatchObject([
      { id: 1, deletedAt: removedAt, revision: 2 },
    ])
  })

  test('publishes restore as a tombstone clear with replayed revision history', async () => {
    await app.call('softDeleteTodo', {
      id: 1,
      at: new Date('2026-08-29T16:00:00.000Z'),
    })
    const drafts = lifecycle()
    const draftId = await drafts.open(0)
    await drafts.append(draftId, [{ path: 'restoreTodo', args: { id: 1 } }])

    expect((await app.call('listActive', {})).result).toEqual([])
    expect(
      await app.system
        .createTracked()
        .withDraft(draftId)
        .from(schema.archivedTodos)
        .where(eq('id', 1))
        .first(),
    ).toMatchObject({ deletedAt: null, revision: 3 })

    await drafts.publish(draftId)

    expect((await app.call('listActive', {})).result).toMatchObject([
      { id: 1, deletedAt: null, revision: 3 },
    ])
  })

  test('fails closed when stored soft-delete custody differs from the schema', async () => {
    const drafts = lifecycle()
    const draftId = await drafts.open(0)
    await drafts.append(draftId, [
      {
        path: 'softDeleteTodo',
        args: { id: 1, at: new Date('2026-08-29T18:00:00.000Z') },
      },
    ])
    await db.execute(sql`
      UPDATE wystack_draft_tables
      SET soft_delete_column = NULL
      WHERE draft_id = ${draftId} AND table_name = 'archivedTodos'
    `)
    await refreshStoredDraftIntegrity(db, draftId)

    await expect(drafts.publish(draftId)).rejects.toMatchObject({
      conflicts: [{ table: 'archivedTodos', id: 1, reason: 'revision' }],
    })
    expect(await drafts.getLog(draftId)).toHaveLength(1)
    expect((await app.call('listActive', {})).result).toHaveLength(1)
  })
})
