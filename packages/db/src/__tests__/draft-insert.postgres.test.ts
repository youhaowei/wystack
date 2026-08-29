import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { createDrizzleTracker } from '../drizzle-tracker'
import { registerTableCapabilities } from '../schema'

const postgresUrl = process.env['WYSTACK_TEST_POSTGRES_URL']
const describeWithPostgres = postgresUrl ? describe : describe.skip

const concurrentItems = pgTable('draft_concurrent_items', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})
registerTableCapabilities(concurrentItems, { draftable: true })

describeWithPostgres('draft inserts — real PostgreSQL multi-connection concurrency', () => {
  const namespace = `wystack_draft_insert_${process.pid}_${Date.now()}`
  const advisoryKey = `wystack:draft-insert-proof:${namespace}`
  let admin: ReturnType<typeof postgres>
  let firstClient: ReturnType<typeof postgres>
  let secondClient: ReturnType<typeof postgres>
  let firstPid: number
  let secondPid: number

  beforeAll(async () => {
    admin = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`)

    firstClient = postgres(postgresUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: namespace },
    })
    secondClient = postgres(postgresUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: namespace },
    })
    await firstClient.unsafe(
      'CREATE TABLE draft_concurrent_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)',
    )
    await firstClient.unsafe(`
      CREATE TABLE wystack_draft_row_changes (
        draft_id TEXT NOT NULL,
        table_key TEXT NOT NULL,
        tenant_key_text TEXT NOT NULL DEFAULT '',
        tenant_key JSONB,
        row_key_text TEXT NOT NULL,
        row_key JSONB NOT NULL,
        operation TEXT NOT NULL,
        base_exists BOOLEAN NOT NULL,
        base_revision JSONB,
        fields JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (draft_id, table_key, tenant_key_text, row_key_text)
      )
    `)
    await firstClient.unsafe(`
      CREATE FUNCTION block_competing_draft_inserts() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('${advisoryKey}', 0));
        RETURN NEW;
      END
      $$
    `)
    await firstClient.unsafe(`
      CREATE TRIGGER block_competing_draft_inserts
      BEFORE INSERT ON wystack_draft_row_changes
      FOR EACH ROW EXECUTE FUNCTION block_competing_draft_inserts()
    `)
    const [firstPidRows, secondPidRows] = await Promise.all([
      firstClient<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`,
      secondClient<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`,
    ])
    firstPid = firstPidRows[0]!.pid
    secondPid = secondPidRows[0]!.pid
  })

  afterAll(async () => {
    await Promise.all([firstClient?.end({ timeout: 1 }), secondClient?.end({ timeout: 1 })])
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`)
      await admin.end({ timeout: 1 })
    }
  })

  async function waitUntilBothWritersReachTheInsert(): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [waiting] = await admin<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM pg_stat_activity
        WHERE pid IN (${firstPid}, ${secondPid})
          AND wait_event_type = 'Lock'
          AND wait_event = 'advisory'
      `
      if (waiting?.count === 2) return
      await Bun.sleep(10)
    }
    throw new Error('Both PostgreSQL writers did not reach the draft insert barrier')
  }

  test('the central unique key rejects one of two concurrent inserts for the same missing row', async () => {
    await admin`SELECT pg_advisory_lock(hashtextextended(${advisoryKey}, 0))`
    const first = createDrizzleTracker(drizzle(firstClient)).withDraft('shared-draft')
    const second = createDrizzleTracker(drizzle(secondClient)).withDraft('shared-draft')
    const outcomesPromise = Promise.allSettled([
      first.into(concurrentItems).insert({ id: 1, title: 'first' }),
      second.into(concurrentItems).insert({ id: 1, title: 'second' }),
    ])

    let barrierFailure: unknown
    try {
      await waitUntilBothWritersReachTheInsert()
    } catch (error) {
      barrierFailure = error
    } finally {
      await admin`SELECT pg_advisory_unlock(hashtextextended(${advisoryKey}, 0))`
    }

    const outcomes = await outcomesPromise
    if (barrierFailure) throw barrierFailure
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]?.reason)).toContain('because it already exists')

    const changes = await firstClient<{ operation: string; title: string }[]>`
      SELECT operation, fields -> 'title' -> 'value' ->> 'value' AS title
      FROM wystack_draft_row_changes
      WHERE draft_id = 'shared-draft'
    `
    expect(changes).toHaveLength(1)
    expect(changes[0]?.operation).toBe('insert')
    expect(['first', 'second']).toContain(changes[0]?.title)
  })
})
