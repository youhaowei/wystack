import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { createDrizzleTracker } from '../drizzle-tracker'
import { int, text as dslText } from '../dsl'
import { eq, gt, gte, lt, lte, ne, type FilterDescriptor } from '../operators'
import { defineSchema } from '../schema'
import { syncSchema } from '../sync'
import { multiTenant } from '../table'

const DRAFT_ID = 'bounded-draft'

const sourceItems = pgTable('bounded_source_items', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  score: integer('score').notNull(),
  note: text('note'),
})

const canonicalTwin = pgTable('bounded_canonical_twin', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  score: integer('score').notNull(),
  note: text('note'),
})

const tenancy = multiTenant({
  key: { property: 'tenantId', column: 'tenant_id', type: dslText },
})
const tenantSchema = defineSchema({
  bounded_tenant_items: tenancy
    .table({ id: int.primaryKey(), title: dslText, score: int })
    .draftable(),
})

const parityCases: Array<{
  name: string
  filter: FilterDescriptor
  direction: 'asc' | 'desc'
  limit: number
}> = [
  {
    name: 'greater than',
    filter: gt('score', 50),
    direction: 'desc',
    limit: 3,
  },
  {
    name: 'greater than or equal',
    filter: gte('score', 40),
    direction: 'asc',
    limit: 4,
  },
  { name: 'less than', filter: lt('score', 90), direction: 'desc', limit: 2 },
  {
    name: 'less than or equal',
    filter: lte('score', 80),
    direction: 'asc',
    limit: 5,
  },
  { name: 'not equal', filter: ne('score', 70), direction: 'desc', limit: 6 },
  { name: 'equal', filter: eq('score', 80), direction: 'asc', limit: 1 },
]

async function createBoundedReadHarness() {
  const pg = new PGlite()
  const db = drizzle(pg)

  await pg.exec(`
    CREATE TABLE bounded_source_items (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      score INTEGER NOT NULL,
      note TEXT
    );
    CREATE INDEX bounded_source_score_id_idx
      ON bounded_source_items (score DESC, id);
    CREATE TABLE bounded_canonical_twin (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      score INTEGER NOT NULL,
      note TEXT
    );
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
    );
    INSERT INTO bounded_source_items (id, title, score, note) VALUES
      (1, 'one', 100, 'one-note'), (2, 'two', 90, 'two-note'),
      (3, 'three', 80, NULL), (4, 'four', 70, 'four-note'),
      (5, 'five', 60, 'five-note'), (6, 'six', 50, 'six-note'),
      (7, 'seven', 40, 'seven-note'), (8, 'eight', 30, 'eight-note');
    INSERT INTO bounded_canonical_twin SELECT * FROM bounded_source_items;
  `)

  await syncSchema(db, tenantSchema)
  const tracker = createDrizzleTracker(db)

  async function updateBoth(id: number, values: Partial<typeof sourceItems.$inferInsert>) {
    await tracker.withDraft(DRAFT_ID).from(sourceItems).where(eq('id', id)).update(values)
    await tracker.from(canonicalTwin).where(eq('id', id)).update(values)
  }

  async function deleteBoth(id: number) {
    await tracker.withDraft(DRAFT_ID).from(sourceItems).where(eq('id', id)).delete()
    await tracker.from(canonicalTwin).where(eq('id', id)).delete()
  }

  async function insertBoth(row: typeof sourceItems.$inferInsert) {
    await tracker.withDraft(DRAFT_ID).into(sourceItems).insert(row)
    await tracker.into(canonicalTwin).insert(row)
  }

  return {
    tracker,
    draftItems: () => tracker.withDraft(DRAFT_ID).from(sourceItems),
    canonicalItems: () => tracker.from(canonicalTwin),
    async applyBoundaryCrossingScenario() {
      await updateBoth(1, { score: 5 })
      await deleteBoth(2)
      await updateBoth(7, { score: 95 })
      await insertBoth({ id: 9, title: 'nine', score: 85, note: 'nine-note' })
      await updateBoth(6, { note: null })
      await updateBoth(8, { title: 'aardvark' })
    },
    close: () => pg.close(),
  }
}

type BoundedReadHarness = Awaited<ReturnType<typeof createBoundedReadHarness>>

let harness: BoundedReadHarness

beforeEach(async () => {
  harness = await createBoundedReadHarness()
})

afterEach(async () => {
  await harness.close()
})

describe('bounded SQL plan shape', () => {
  test('selects canonical L + M candidates and every changed canonical key', async () => {
    await harness.applyBoundaryCrossingScenario()

    const lowered = harness
      .draftItems()
      .where(gte('score', 50))
      .orderBy('score', 'desc')
      .limit(3)
      .toSql()

    expect(lowered.sql).toContain('WITH draft_delta AS')
    expect(lowered.sql).toContain('base_top AS')
    expect(lowered.sql).toContain('(SELECT COUNT(*) FROM draft_delta)')
    expect(lowered.sql).toContain('candidate_base AS')
    expect(lowered.sql).toContain('NOT EXISTS')
    expect(lowered.sql).toContain('UNION ALL')
    expect(lowered.sql).toContain('FULL OUTER JOIN draft_delta')
    expect(lowered.sql).toContain('c."score" >=')
    expect(lowered.sql).toContain('ORDER BY c."score" DESC, c."id"')
  })

  test('uses filtered candidates when a filtered read has no limit', async () => {
    await harness.applyBoundaryCrossingScenario()

    const filtered = harness.draftItems().where(gte('score', 50)).toSql()

    expect(filtered.sql).toContain('WITH draft_delta AS')
    expect(filtered.sql).not.toContain('(SELECT COUNT(*) FROM draft_delta)')
    expect(filtered.sql).not.toContain('ORDER BY c.')
  })

  test('uses the exact full-join fallback for an unfiltered read', async () => {
    await harness.applyBoundaryCrossingScenario()

    const unfiltered = harness.draftItems().toSql()

    expect(unfiltered.sql).not.toContain('WITH draft_delta AS')
    expect(unfiltered.sql).toContain('FULL OUTER JOIN')
  })
})

describe('bounded SQL result parity', () => {
  for (const current of parityCases) {
    test(`matches a materialized canonical twin for ${current.name} filters`, async () => {
      await harness.applyBoundaryCrossingScenario()

      const effective = await harness
        .draftItems()
        .where(current.filter)
        .orderBy('score', current.direction)
        .limit(current.limit)
        .all()
      const expected = await harness
        .canonicalItems()
        .where(current.filter)
        .orderBy('score', current.direction)
        .limit(current.limit)
        .all()

      expect(effective).toEqual(expected)
    })
  }

  test('includes promoted and inserted rows while excluding demoted and deleted rows', async () => {
    await harness.applyBoundaryCrossingScenario()

    const rows = await harness
      .draftItems()
      .where(gte('score', 50))
      .orderBy('score', 'desc')
      .limit(3)
      .all()

    expect(rows.map((row) => [row.id, row.score])).toEqual([
      [7, 95],
      [9, 85],
      [3, 80],
    ])
  })

  test('first returns the same row as the materialized canonical twin', async () => {
    await harness.applyBoundaryCrossingScenario()

    const effective = await harness
      .draftItems()
      .where(gte('score', 50))
      .orderBy('score', 'desc')
      .first()
    const expected = await harness
      .canonicalItems()
      .where(gte('score', 50))
      .orderBy('score', 'desc')
      .first()

    expect(effective).toEqual(expected)
  })

  test('limit zero returns no rows', async () => {
    await harness.applyBoundaryCrossingScenario()

    const rows = await harness.draftItems().where(gte('score', 50)).limit(0).all()

    expect(rows).toEqual([])
  })

  test('preserves PostgreSQL text ordering through a projection', async () => {
    await harness.applyBoundaryCrossingScenario()

    const effective = await harness
      .draftItems()
      .select('id', 'title')
      .orderBy('title', 'asc')
      .limit(3)
      .all()
    const expected = await harness
      .canonicalItems()
      .select('id', 'title')
      .orderBy('title', 'asc')
      .limit(3)
      .all()

    expect(effective).toEqual(expected)
  })

  test('preserves PostgreSQL null ordering through a projection', async () => {
    await harness.applyBoundaryCrossingScenario()

    const effective = await harness
      .draftItems()
      .select('id', 'note')
      .orderBy('note', 'asc')
      .limit(4)
      .all()
    const expected = await harness
      .canonicalItems()
      .select('id', 'note')
      .orderBy('note', 'asc')
      .limit(4)
      .all()

    expect(effective).toEqual(expected)
  })
})

describe('bounded SQL tenant isolation', () => {
  test("the same draft ID cannot mix another tenant's candidates or changes", async () => {
    const alpha = harness.tracker.withTenant('alpha')
    const beta = harness.tracker.withTenant('beta')

    await alpha
      .into(tenantSchema.bounded_tenant_items)
      .insert({ id: 1, title: 'alpha one', score: 10 })
    await alpha
      .into(tenantSchema.bounded_tenant_items)
      .insert({ id: 2, title: 'alpha two', score: 20 })
    await beta
      .into(tenantSchema.bounded_tenant_items)
      .insert({ id: 3, title: 'beta one', score: 100 })
    await beta
      .into(tenantSchema.bounded_tenant_items)
      .insert({ id: 4, title: 'beta two', score: 200 })

    await alpha
      .withDraft('shared-draft')
      .from(tenantSchema.bounded_tenant_items)
      .where(eq('id', 1))
      .update({ score: 30 })
    await beta
      .withDraft('shared-draft')
      .from(tenantSchema.bounded_tenant_items)
      .where(eq('id', 3))
      .update({ score: 300 })

    const alphaRows = await alpha
      .withDraft('shared-draft')
      .from(tenantSchema.bounded_tenant_items)
      .where(gte('score', 0))
      .orderBy('score', 'desc')
      .limit(2)
      .all()
    const betaRows = await beta
      .withDraft('shared-draft')
      .from(tenantSchema.bounded_tenant_items)
      .where(gte('score', 0))
      .orderBy('score', 'desc')
      .limit(2)
      .all()

    expect(alphaRows.map((row) => [row.title, row.score])).toEqual([
      ['alpha one', 30],
      ['alpha two', 20],
    ])
    expect(betaRows.map((row) => [row.title, row.score])).toEqual([
      ['beta one', 300],
      ['beta two', 200],
    ])
  })
})
