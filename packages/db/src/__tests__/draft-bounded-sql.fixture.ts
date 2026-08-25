import { afterEach, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { createDrizzleTracker } from '../drizzle-tracker'
import { int, text as dslText } from '../dsl'
import { eq, type FilterDescriptor } from '../operators'
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

type BoundedRow = typeof sourceItems.$inferSelect

interface ComparableItemsRead {
  select(...columns: Array<keyof BoundedRow & string>): ComparableItemsRead
  where(filters: FilterDescriptor | FilterDescriptor[]): ComparableItemsRead
  orderBy(column: string, direction?: 'asc' | 'desc'): ComparableItemsRead
  limit(count: number): ComparableItemsRead
  all(): Promise<Array<Partial<BoundedRow>>>
  first(): Promise<Partial<BoundedRow> | null>
}

async function createHarness() {
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

  async function applyBoundaryCrossingChanges() {
    await updateBoth(1, { score: 5 })
    await tracker.withDraft(DRAFT_ID).from(sourceItems).where(eq('id', 2)).delete()
    await tracker.from(canonicalTwin).where(eq('id', 2)).delete()
    await updateBoth(7, { score: 95 })

    const inserted = { id: 9, title: 'nine', score: 85, note: 'nine-note' }
    await tracker.withDraft(DRAFT_ID).into(sourceItems).insert(inserted)
    await tracker.into(canonicalTwin).insert(inserted)

    await updateBoth(6, { note: null })
    await updateBoth(8, { title: 'aardvark' })
  }

  await applyBoundaryCrossingChanges()

  return {
    tracker,
    draftItems: () => tracker.withDraft(DRAFT_ID).from(sourceItems),
    canonicalItems: () => tracker.from(canonicalTwin),
    close: () => pg.close(),
  }
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

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  function current() {
    if (!harness) throw new Error('The bounded draft scenario is not active')
    return harness
  }

  return {
    draftItems: () => current().draftItems(),

    async readBoth<TResult>(read: (items: ComparableItemsRead) => Promise<TResult>) {
      const active = current()
      const effective = await read(active.draftItems() as unknown as ComparableItemsRead)
      const canonical = await read(active.canonicalItems() as unknown as ComparableItemsRead)
      return { effective, canonical }
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
