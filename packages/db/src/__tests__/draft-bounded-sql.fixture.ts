import { afterEach, beforeEach } from 'bun:test'
import { createTestPg, useTestPglite } from '@wystack/db/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { createDrizzleTracker } from '../drizzle-tracker'
import { int, text as dslText } from '../dsl'
import { eq, type FilterDescriptor } from '../operators'
import { defineSchema, registerTableCapabilities } from '../schema'
import { syncSchema } from '../sync'
import { multiTenant } from '../table'
import type { DrizzleDb } from '../tracker-core'
import { draftChangesTableDdl } from './draft-storage.fixture'

export function useBoundedDraftHarness(): void {
  useTestPglite()
}

const DRAFT_ID = 'bounded-draft'
const SOURCE_ROW_COUNT = 120
const EXPECTED_DRAFT_CHANGE_COUNT = 8

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

registerTableCapabilities(sourceItems, { draftable: true })

const tenancy = multiTenant({
  key: { property: 'tenantId', column: 'tenant_id', type: dslText },
})

const tenantSchema = defineSchema({
  bounded_tenant_items: tenancy
    .table({ id: int.primaryKey(), title: dslText, score: int })
    .draftable(),
})

type BoundedRow = typeof sourceItems.$inferSelect

interface ComparableItemsRead {
  select(...columns: Array<keyof BoundedRow & string>): ComparableItemsRead
  where(filters: FilterDescriptor | FilterDescriptor[]): ComparableItemsRead
  orderBy(column: string, direction?: 'asc' | 'desc'): ComparableItemsRead
  limit(count: number): ComparableItemsRead
  all(): Promise<Array<Partial<BoundedRow>>>
  first(): Promise<Partial<BoundedRow> | null>
}

export const boundedDraftSetupSql = `
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
    ${draftChangesTableDdl}
    INSERT INTO bounded_source_items (id, title, score, note)
    SELECT
      id,
      'item-' || lpad(id::text, 3, '0'),
      121 - ((id + 1) / 2),
      CASE
        WHEN id IN (3, 100) THEN NULL
        ELSE 'group-' || lpad((id % 7)::text, 2, '0')
      END
    FROM generate_series(1, ${SOURCE_ROW_COUNT}) AS id;
    INSERT INTO bounded_canonical_twin SELECT * FROM bounded_source_items;
  `

export async function createBoundedDraftHarness(
  db: DrizzleDb,
  countDraftChanges: () => Promise<number>,
) {
  await syncSchema(db, tenantSchema)
  const tracker = createDrizzleTracker(db)

  async function updateBoth(id: number, values: Partial<typeof sourceItems.$inferInsert>) {
    await tracker.withDraft(DRAFT_ID).from(sourceItems).where(eq('id', id)).update(values)
    await tracker.from(canonicalTwin).where(eq('id', id)).update(values)
  }

  async function applyBoundaryCrossingChanges() {
    // Move or remove both rows from the original descending boundary.
    await updateBoth(1, { score: 10, note: null })
    await tracker.withDraft(DRAFT_ID).from(sourceItems).where(eq('id', 2)).delete()
    await tracker.from(canonicalTwin).where(eq('id', 2)).delete()

    // Start far below the ascending boundary, then enter it with a tied score.
    await updateBoth(10, { score: 60, title: 'aardvark', note: 'aaa-note' })
    await tracker.withDraft(DRAFT_ID).from(sourceItems).where(eq('id', 118)).delete()
    await tracker.from(canonicalTwin).where(eq('id', 118)).delete()

    // Start far below the descending boundary, then enter it as a deterministic tie.
    await updateBoth(119, { score: 130, title: 'boundary-first', note: null })
    await updateBoth(120, { score: 130, title: 'boundary-second', note: 'zzzz-note' })

    const insertedRows = [
      { id: 121, title: 'inserted-high', score: 129, note: null },
      { id: 122, title: 'inserted-low', score: 60, note: 'aaa-note' },
    ]
    for (const inserted of insertedRows) {
      await tracker.withDraft(DRAFT_ID).into(sourceItems).insert(inserted)
      await tracker.into(canonicalTwin).insert(inserted)
    }
  }

  await applyBoundaryCrossingChanges()

  return {
    tracker,
    draftItems: () => tracker.withDraft(DRAFT_ID).from(sourceItems),
    canonicalItems: () => tracker.from(canonicalTwin),
    async readBoth<TResult>(read: (items: ComparableItemsRead) => Promise<TResult>) {
      const effective = await read(tracker.withDraft(DRAFT_ID).from(sourceItems))
      const canonical = await read(tracker.from(canonicalTwin))
      return { effective, canonical }
    },
    async pruningDimensions() {
      const canonicalRows = await tracker.from(canonicalTwin).all()
      return {
        canonicalRows: canonicalRows.length,
        draftChanges: await countDraftChanges(),
      }
    },
  }
}

async function createHarness() {
  const pg = createTestPg()
  const db = drizzle(pg)
  await pg.exec(boundedDraftSetupSql)
  const harness = await createBoundedDraftHarness(db, async () => {
    const changes = await pg.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM wystack_draft_row_changes
       WHERE draft_id = $1 AND table_key = $2`,
      [DRAFT_ID, 'bounded_source_items'],
    )
    return changes.rows[0]?.count ?? 0
  })
  return harness
}

type Harness = Awaited<ReturnType<typeof createHarness>>

/** Lower SQL through Drizzle's mock dialect; no database or seed data is needed. */
export function boundedDraftPlan() {
  const tracker = createDrizzleTracker(drizzle.mock())
  return { draftItems: () => tracker.withDraft(DRAFT_ID).from(sourceItems) }
}

/**
 * Installs one fresh bounded-read database per test. The public surface names
 * only scenario concepts; PGlite, DDL, mirroring, and cleanup stay here.
 * Bun's hooks own one mutable harness slot, so this fixture is intentionally
 * serial and must not be used from `test.concurrent`.
 */
export function boundedDraftScenario() {
  let harness: Harness | undefined

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness = undefined
  })

  function current() {
    if (!harness) throw new Error('The bounded draft scenario is not active')
    return harness
  }

  return {
    draftItems: () => current().draftItems(),

    async readBoth<TResult>(read: (items: ComparableItemsRead) => Promise<TResult>) {
      return current().readBoth(read)
    },

    async pruningDimensions() {
      const dimensions = await current().pruningDimensions()
      if (dimensions.draftChanges !== EXPECTED_DRAFT_CHANGE_COUNT) {
        throw new Error(
          `Fixture expected ${EXPECTED_DRAFT_CHANGE_COUNT} draft changes, got ${dimensions.draftChanges}`,
        )
      }
      return dimensions
    },

    async sharedDraftAcrossTwoTenants() {
      const tracker = current().tracker
      const alpha = tracker.withTenant('alpha')
      const beta = tracker.withTenant('beta')

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

      return {
        alphaItems: () => alpha.withDraft('shared-draft').from(tenantSchema.bounded_tenant_items),
        betaItems: () => beta.withDraft('shared-draft').from(tenantSchema.bounded_tenant_items),
      }
    },
  }
}
