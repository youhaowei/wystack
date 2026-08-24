import { beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { createDrizzleTracker } from '../drizzle-tracker'
import { int, text as dslText } from '../dsl'
import { eq, gt, gte, lt, lte, ne, type FilterDescriptor } from '../operators'
import { defineSchema } from '../schema'
import { syncSchema } from '../sync'
import { multiTenant } from '../table'

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

let pg: PGlite
let db: ReturnType<typeof drizzle>
let tracked: ReturnType<typeof createDrizzleTracker>

beforeEach(async () => {
  pg = new PGlite()
  db = drizzle(pg)
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
  tracked = createDrizzleTracker(db)
})

async function applyEquivalentChanges() {
  const draft = tracked.withDraft('bounded-draft')
  await draft.from(sourceItems).where(eq('id', 1)).update({ score: 5 })
  await draft.from(sourceItems).where(eq('id', 2)).delete()
  await draft.from(sourceItems).where(eq('id', 7)).update({ score: 95 })
  await draft.into(sourceItems).insert({ id: 9, title: 'nine', score: 85, note: 'nine-note' })
  await draft.from(sourceItems).where(eq('id', 6)).update({ note: null })
  await draft.from(sourceItems).where(eq('id', 8)).update({ title: 'aardvark' })

  await tracked.from(canonicalTwin).where(eq('id', 1)).update({ score: 5 })
  await tracked.from(canonicalTwin).where(eq('id', 2)).delete()
  await tracked.from(canonicalTwin).where(eq('id', 7)).update({ score: 95 })
  await tracked.into(canonicalTwin).insert({ id: 9, title: 'nine', score: 85, note: 'nine-note' })
  await tracked.from(canonicalTwin).where(eq('id', 6)).update({ note: null })
  await tracked.from(canonicalTwin).where(eq('id', 8)).update({ title: 'aardvark' })
}

describe('central JSONB + bounded SQL candidate plan', () => {
  test('lowers top L + M base candidates plus every changed canonical key', async () => {
    await applyEquivalentChanges()
    const lowered = tracked
      .withDraft('bounded-draft')
      .from(sourceItems)
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

  test('matches an independently materialized canonical twin across filter operators and limits', async () => {
    await applyEquivalentChanges()
    const cases: Array<{
      filter: FilterDescriptor
      direction: 'asc' | 'desc'
      limit: number
    }> = [
      { filter: gt('score', 50), direction: 'desc', limit: 3 },
      { filter: gte('score', 40), direction: 'asc', limit: 4 },
      { filter: lt('score', 90), direction: 'desc', limit: 2 },
      { filter: lte('score', 80), direction: 'asc', limit: 5 },
      { filter: ne('score', 70), direction: 'desc', limit: 6 },
      { filter: eq('score', 80), direction: 'asc', limit: 1 },
    ]

    for (const current of cases) {
      const effective = await tracked
        .withDraft('bounded-draft')
        .from(sourceItems)
        .where(current.filter)
        .orderBy('score', current.direction)
        .limit(current.limit)
        .all()
      const expected = await tracked
        .from(canonicalTwin)
        .where(current.filter)
        .orderBy('score', current.direction)
        .limit(current.limit)
        .all()

      expect(effective).toEqual(expected)
    }
  })

  test('returns the expected top rows when changes enter, leave, insert, and delete', async () => {
    await applyEquivalentChanges()

    const rows = await tracked
      .withDraft('bounded-draft')
      .from(sourceItems)
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

  test('uses filtered candidates without a limit and retains a full-plan fallback for unfiltered reads', async () => {
    await applyEquivalentChanges()

    const filtered = tracked
      .withDraft('bounded-draft')
      .from(sourceItems)
      .where(gte('score', 50))
      .toSql()
    const unfiltered = tracked.withDraft('bounded-draft').from(sourceItems).toSql()

    expect(filtered.sql).toContain('WITH draft_delta AS')
    expect(filtered.sql).not.toContain('(SELECT COUNT(*) FROM draft_delta)')
    expect(filtered.sql).not.toContain('ORDER BY c.')
    expect(unfiltered.sql).not.toContain('WITH draft_delta AS')
    expect(unfiltered.sql).toContain('FULL OUTER JOIN')
  })

  test('first and limit zero preserve canonical behavior', async () => {
    await applyEquivalentChanges()

    const effectiveFirst = await tracked
      .withDraft('bounded-draft')
      .from(sourceItems)
      .where(gte('score', 50))
      .orderBy('score', 'desc')
      .first()
    const canonicalFirst = await tracked
      .from(canonicalTwin)
      .where(gte('score', 50))
      .orderBy('score', 'desc')
      .first()
    const none = await tracked
      .withDraft('bounded-draft')
      .from(sourceItems)
      .where(gte('score', 50))
      .limit(0)
      .all()

    expect(effectiveFirst).toEqual(canonicalFirst)
    expect(none).toEqual([])
  })

  test('keeps SQL text and null ordering while projecting the bounded result', async () => {
    await applyEquivalentChanges()

    const effectiveByNote = await tracked
      .withDraft('bounded-draft')
      .from(sourceItems)
      .select('id', 'note')
      .orderBy('note', 'asc')
      .limit(4)
      .all()
    const canonicalByNote = await tracked
      .from(canonicalTwin)
      .select('id', 'note')
      .orderBy('note', 'asc')
      .limit(4)
      .all()
    const effectiveByTitle = await tracked
      .withDraft('bounded-draft')
      .from(sourceItems)
      .select('id', 'title')
      .orderBy('title', 'asc')
      .limit(3)
      .all()
    const canonicalByTitle = await tracked
      .from(canonicalTwin)
      .select('id', 'title')
      .orderBy('title', 'asc')
      .limit(3)
      .all()

    expect(effectiveByNote).toEqual(canonicalByNote)
    expect(effectiveByTitle).toEqual(canonicalByTitle)
  })

  test('scopes bounded candidates and changes to one tenant', async () => {
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')
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
