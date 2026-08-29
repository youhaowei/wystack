import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { createDrizzleTracker } from '../drizzle-tracker'
import { eq } from '../operators'
import { registerTableCapabilities } from '../schema'
import type { DrizzleDb } from '../tracker-core'
import { draftChangesTableDdl } from './draft-storage.fixture'

const postgresUrl = process.env['WYSTACK_TEST_POSTGRES_URL']
const describeWithPostgres = postgresUrl ? describe : describe.skip

const predicateItems = pgTable('draft_predicate_items', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  note: text('note').notNull(),
})
registerTableCapabilities(predicateItems, { draftable: true })

/** Pause a draft transaction after its predicate has returned the initial candidates. */
function pauseAfterPredicateSelection(raw: DrizzleDb): {
  db: DrizzleDb
  selectionReached: Promise<void>
  continueMutation(): void
} {
  let announceSelection!: () => void
  const selectionReached = new Promise<void>((resolve) => {
    announceSelection = resolve
  })
  let continueMutation!: () => void
  const mayContinue = new Promise<void>((resolve) => {
    continueMutation = resolve
  })

  const db = new Proxy(raw, {
    get(target, property, receiver) {
      if (property !== 'transaction') {
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }

      return async (
        callback: (transaction: DrizzleDb) => Promise<unknown>,
        config?: unknown,
      ): Promise<unknown> =>
        target.transaction(async (transaction: DrizzleDb) => {
          let firstExecute = true
          const pausedTransaction = new Proxy(transaction, {
            get(txTarget, txProperty, txReceiver) {
              const value = Reflect.get(txTarget, txProperty, txReceiver)
              if (txProperty !== 'execute') {
                return typeof value === 'function' ? value.bind(txTarget) : value
              }
              return async (...args: unknown[]) => {
                const result = await Reflect.apply(value, txTarget, args)
                if (firstExecute) {
                  firstExecute = false
                  announceSelection()
                  await mayContinue
                }
                return result
              }
            },
          })
          return callback(pausedTransaction)
        }, config)
    },
  })

  return { db, selectionReached, continueMutation }
}

describeWithPostgres('draft predicate writes — real PostgreSQL concurrency', () => {
  const namespace = `wystack_draft_predicate_${process.pid}_${Date.now()}`
  let admin: ReturnType<typeof postgres>
  let mutationClient: ReturnType<typeof postgres>
  let canonicalClient: ReturnType<typeof postgres>

  beforeAll(async () => {
    admin = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`)
    mutationClient = postgres(postgresUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: namespace },
    })
    canonicalClient = postgres(postgresUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: namespace },
    })
    await mutationClient.unsafe(`
      CREATE TABLE draft_predicate_items (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        note TEXT NOT NULL
      )
    `)
    await mutationClient.unsafe(draftChangesTableDdl)
  })

  beforeEach(async () => {
    await mutationClient.unsafe('TRUNCATE draft_predicate_items, wystack_draft_row_changes')
    await mutationClient.unsafe(
      `INSERT INTO draft_predicate_items (id, title, note) VALUES (1, 'old', 'canonical')`,
    )
  })

  afterAll(async () => {
    await Promise.all([mutationClient?.end({ timeout: 1 }), canonicalClient?.end({ timeout: 1 })])
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`)
      await admin.end({ timeout: 1 })
    }
  })

  test('update excludes a row that stops matching before its draft anchor is created', async () => {
    const paused = pauseAfterPredicateSelection(drizzle(mutationClient))
    const draft = createDrizzleTracker(paused.db).withDraft('update-draft')
    const updating = draft
      .from(predicateItems)
      .where(eq('title', 'old'))
      .update({ note: 'drafted' })

    await paused.selectionReached
    try {
      await canonicalClient.unsafe(
        `UPDATE draft_predicate_items SET title = 'concurrent' WHERE id = 1`,
      )
    } finally {
      paused.continueMutation()
    }

    expect(await updating).toEqual([])
    const [canonical] = await mutationClient<{ title: string; note: string }[]>`
      SELECT title, note FROM draft_predicate_items WHERE id = 1
    `
    expect(canonical).toEqual({ title: 'concurrent', note: 'canonical' })
    const [changeCount] = await mutationClient<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM wystack_draft_row_changes
    `
    expect(changeCount?.count).toBe(0)
  })

  test('delete excludes a row that stops matching before its draft anchor is created', async () => {
    const paused = pauseAfterPredicateSelection(drizzle(mutationClient))
    const draft = createDrizzleTracker(paused.db).withDraft('delete-draft')
    const deleting = draft.from(predicateItems).where(eq('title', 'old')).delete()

    await paused.selectionReached
    try {
      await canonicalClient.unsafe(
        `UPDATE draft_predicate_items SET title = 'concurrent' WHERE id = 1`,
      )
    } finally {
      paused.continueMutation()
    }

    expect(await deleting).toEqual([])
    const [canonical] = await mutationClient<{ title: string; note: string }[]>`
      SELECT title, note FROM draft_predicate_items WHERE id = 1
    `
    expect(canonical).toEqual({ title: 'concurrent', note: 'canonical' })
    const [changeCount] = await mutationClient<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM wystack_draft_row_changes
    `
    expect(changeCount?.count).toBe(0)
  })
})
