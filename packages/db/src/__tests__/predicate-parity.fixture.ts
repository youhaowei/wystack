import { afterEach, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { createDrizzleTracker } from '../drizzle-tracker'
import { eq, type FilterDescriptor } from '../operators'
import { registerTableCapabilities } from '../schema'
import { draftChangesTableDdl } from './draft-storage.fixture'

const DRAFT_ID = 'predicate-parity'

const predicateItems = pgTable('predicate_items', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  score: integer('score').notNull(),
  owner: text('owner'),
})

const materializedItems = pgTable('predicate_materialized_items', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  score: integer('score').notNull(),
  owner: text('owner'),
})

registerTableCapabilities(predicateItems, { draftable: true })

const setupSql = `
  CREATE TABLE predicate_items (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    score INTEGER NOT NULL,
    owner TEXT
  );
  CREATE TABLE predicate_materialized_items (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    score INTEGER NOT NULL,
    owner TEXT
  );
  ${draftChangesTableDdl}
  INSERT INTO predicate_items (id, title, status, score, owner) VALUES
    (1, 'Alpha',   'active',   10, 'alice'),
    (2, 'Beta',    'active',   20, NULL),
    (3, 'Gamma',   'blocked',  30, 'bob'),
    (4, 'Delta',   'archived', 40, NULL),
    (5, 'Epsilon', 'ready',    50, 'carol'),
    (7, 'Theta',   'blocked',  70, 'dora');
  INSERT INTO predicate_materialized_items SELECT * FROM predicate_items;
`

type ItemInsert = typeof predicateItems.$inferInsert
type ItemRow = typeof predicateItems.$inferSelect

function sortedIds(rows: ItemRow[]): number[] {
  return rows.map(({ id }) => id).sort((a, b) => a - b)
}

async function createHarness() {
  const pg = new PGlite()
  const db = drizzle(pg)
  await pg.exec(setupSql)
  const tracker = createDrizzleTracker(db)
  const draftItems = () => tracker.withDraft(DRAFT_ID).from(predicateItems)
  const canonicalItems = () => tracker.from(materializedItems)

  async function updateBoth(id: number, values: Partial<ItemInsert>) {
    await draftItems().where(eq('id', id)).update(values)
    await canonicalItems().where(eq('id', id)).update(values)
  }

  // Each edit changes predicate membership, rather than merely changing a
  // projected value. The materialized table is an independent canonical oracle
  // for the source table plus its draft overlay.
  await updateBoth(1, { status: 'blocked', owner: null })
  await updateBoth(2, { status: 'archived', owner: 'ben' })
  await updateBoth(3, { status: 'archived' })
  await draftItems().where(eq('id', 4)).delete()
  await canonicalItems().where(eq('id', 4)).delete()
  const inserted = { id: 6, title: 'Zeta', status: 'ready', score: 60, owner: null }
  await tracker.withDraft(DRAFT_ID).into(predicateItems).insert(inserted)
  await tracker.into(materializedItems).insert(inserted)

  async function rowsMatching(predicate: FilterDescriptor) {
    const [effective, canonical] = await Promise.all([
      draftItems().where(predicate).orderBy('id').all(),
      canonicalItems().where(predicate).orderBy('id').all(),
    ])
    return { effective, canonical }
  }

  async function allRows() {
    const [effective, canonical] = await Promise.all([
      draftItems().orderBy('id').all(),
      canonicalItems().orderBy('id').all(),
    ])
    return { effective, canonical }
  }

  async function updateMatching(predicate: FilterDescriptor, values: Partial<ItemInsert>) {
    const [effectiveReturned, canonicalReturned] = await Promise.all([
      draftItems().where(predicate).update(values),
      canonicalItems().where(predicate).update(values),
    ])
    return {
      effectiveReturnedIds: sortedIds(effectiveReturned),
      canonicalReturnedIds: sortedIds(canonicalReturned),
      rows: await allRows(),
    }
  }

  async function deleteMatching(predicate: FilterDescriptor) {
    const [effectiveReturned, canonicalReturned] = await Promise.all([
      draftItems().where(predicate).delete(),
      canonicalItems().where(predicate).delete(),
    ])
    return {
      effectiveReturnedIds: sortedIds(effectiveReturned),
      canonicalReturnedIds: sortedIds(canonicalReturned),
      rows: await allRows(),
    }
  }

  return { rowsMatching, updateMatching, deleteMatching, close: () => pg.close() }
}

type Harness = Awaited<ReturnType<typeof createHarness>>

/**
 * One fresh independently materialized oracle per proof. Runtime and mirroring
 * mechanics stay here so the behavioral tests expose only causal predicates.
 */
export function predicateParityScenario() {
  let harness: Harness | undefined

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(async () => {
    await harness?.close()
    harness = undefined
  })

  function current() {
    if (!harness) throw new Error('The predicate parity scenario is not active')
    return harness
  }

  return {
    rowsMatching: (predicate: FilterDescriptor) => current().rowsMatching(predicate),
    updateMatching: (predicate: FilterDescriptor, values: Partial<ItemInsert>) =>
      current().updateMatching(predicate, values),
    deleteMatching: (predicate: FilterDescriptor) => current().deleteMatching(predicate),
  }
}
