import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, lt, ne } from '../operators'
import { boundedDraftSetupSql, createBoundedDraftHarness } from './draft-bounded-sql.fixture'

const postgresUrl = process.env['WYSTACK_TEST_POSTGRES_URL']
const describeWithPostgres = postgresUrl ? describe : describe.skip

describeWithPostgres('bounded SQL result parity — real PostgreSQL', () => {
  const namespace = `wystack_bounded_${process.pid}_${Date.now()}`
  let admin: ReturnType<typeof postgres>
  let client: ReturnType<typeof postgres>
  let harness: Awaited<ReturnType<typeof createBoundedDraftHarness>>

  beforeAll(async () => {
    admin = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`)
    client = postgres(postgresUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: namespace },
    })
    await client.unsafe(boundedDraftSetupSql)
    harness = await createBoundedDraftHarness(drizzle(client), async () => {
      const [row] = await client<{ count: number }[]>`
        SELECT COUNT(*)::integer AS count
        FROM wystack_draft_row_changes
        WHERE draft_id = 'bounded-draft' AND table_key = 'bounded_source_items'
      `
      return row?.count ?? 0
    })
  })

  afterAll(async () => {
    await client?.end({ timeout: 1 })
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`)
      await admin.end({ timeout: 1 })
    }
  })

  test('fixture exercises a bounded prefix rather than the whole table', async () => {
    const { canonicalRows, draftChanges } = await harness.pruningDimensions()
    expect(canonicalRows).toBeGreaterThan(8 + draftChanges)
  })

  const cases = [
    {
      behavior: 'less-than with ascending order and limit',
      filter: lt('score', 100),
      direction: 'asc' as const,
      limit: 8,
      expectedIds: [1, 10, 122, 117, 115, 116, 113, 114],
    },
    {
      behavior: 'not-equal with descending order and limit',
      filter: ne('score', 130),
      direction: 'desc' as const,
      limit: 8,
      expectedIds: [121, 3, 4, 5, 6, 7, 8, 9],
    },
    {
      behavior: 'equal tied rows with primary-key tie breaking',
      filter: eq('score', 130),
      direction: 'asc' as const,
      limit: 2,
      expectedIds: [119, 120],
    },
  ]

  for (const example of cases) {
    test(example.behavior, async () => {
      const { effective, canonical } = await harness.readBoth((items) =>
        items.where(example.filter).orderBy('score', example.direction).limit(example.limit).all(),
      )
      expect(effective).toEqual(canonical)
      expect(effective.map((row) => row.id)).toEqual(example.expectedIds)
    })
  }

  test('order plus implicit primary-key tie breaking preserves the bounded prefix', async () => {
    const { effective, canonical } = await harness.readBoth((items) =>
      items.orderBy('score', 'desc').limit(4).all(),
    )
    expect(effective).toEqual(canonical)
    expect(effective.map((row) => row.id)).toEqual([119, 120, 121, 3])
  })
})
