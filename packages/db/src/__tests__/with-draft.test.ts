/**
 * Tests for `TrackedDb.withDraft(draftId)` — the draft coalesce read primitive.
 *
 * The draft table convention is `<base_table>__draft`. The coalesce:
 * - applies draft edits (delta wins over canonical)
 * - suppresses tombstoned rows (__tombstone = true)
 * - surfaces draft inserts (rows present only in the draft table)
 * - leaves the canonical `from().all()` path structurally untouched
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { pgTable, integer, text as pgText, boolean as pgBoolean } from 'drizzle-orm/pg-core'
import { createTrackedDb, DraftSelectBuilder, SelectBuilder } from '../tracked-db'

// ---------------------------------------------------------------------------
// Toy schema — raw pgTable, no defineSchema wrapper needed
// ---------------------------------------------------------------------------

const todos = pgTable('todos', {
  id: integer('id').primaryKey(),
  title: pgText('title').notNull(),
  done: pgBoolean('done').notNull(),
})

const todosDraft = pgTable('todos__draft', {
  draftId: pgText('draft_id').notNull(),
  id: integer('id').notNull(),
  title: pgText('title'),
  done: pgBoolean('done'),
  tombstone: pgBoolean('__tombstone').notNull(),
})

const widgets = pgTable('widgets', {
  id: integer('id').primaryKey(),
  name: pgText('name').notNull(),
})

const widgetsDraft = pgTable('widgets__draft', {
  draftId: pgText('draft_id').notNull(),
  id: integer('id').notNull(),
  name: pgText('name'),
  tombstone: pgBoolean('__tombstone').notNull(),
})

// Draft table Drizzle schemas — not passed to withDraft (the `__draft` suffix
// is derived from the base table name by convention), but kept here as
// typed references for future Drizzle-DSL query work (e.g. YW-124).
void todosDraft
void widgetsDraft

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

let pg: PGlite
let db: ReturnType<typeof drizzle>
let tracked: ReturnType<typeof createTrackedDb>

beforeEach(async () => {
  pg = new PGlite()
  db = drizzle(pg)

  // Base tables
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS widgets (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    )
  `)

  // Draft shadow tables
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos__draft (
      draft_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      title TEXT,
      done BOOLEAN,
      __tombstone BOOLEAN NOT NULL,
      PRIMARY KEY (draft_id, id)
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS widgets__draft (
      draft_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      name TEXT,
      __tombstone BOOLEAN NOT NULL,
      PRIMARY KEY (draft_id, id)
    )
  `)

  // Canonical todos seed: {1,apple,false}, {2,banana,false}, {3,cherry,false}
  await db.execute(`
    INSERT INTO todos (id, title, done) VALUES
      (1, 'apple', false),
      (2, 'banana', false),
      (3, 'cherry', false)
  `)

  // Draft d1:
  //   - id=1: edit title to 'APPLE-edited'
  //   - id=2: tombstone (delete)
  //   - id=4: insert 'date-new'
  await db.execute(`
    INSERT INTO todos__draft (draft_id, id, title, done, __tombstone) VALUES
      ('d1', 1, 'APPLE-edited', false, false),
      ('d1', 2, null, null, true),
      ('d1', 4, 'date-new', false, false)
  `)

  // Canonical widgets seed: {1,'gear'}, {2,'cog'}
  await db.execute(`
    INSERT INTO widgets (id, name) VALUES (1, 'gear'), (2, 'cog')
  `)

  // Draft dW:
  //   - id=1: edit name to 'GEAR-edited'
  //   - id=3: insert 'sprocket'
  await db.execute(`
    INSERT INTO widgets__draft (draft_id, id, name, __tombstone) VALUES
      ('dW', 1, 'GEAR-edited', false),
      ('dW', 3, 'sprocket', false)
  `)

  tracked = createTrackedDb(db)
})

// ---------------------------------------------------------------------------
// Test 1: Coalesced read — delta wins, tombstone omitted, draft-insert appears
// ---------------------------------------------------------------------------

describe('withDraft coalesced read', () => {
  test('delta wins, tombstoned row omitted, draft-only insert appears', async () => {
    const rows = await tracked.withDraft('d1').from(todos).all()

    // Expected: id=1 (edited), id=3 (canonical, unchanged), id=4 (draft insert)
    // id=2 is tombstoned — must not appear.
    expect(rows).toHaveLength(3)

    const byId = Object.fromEntries(rows.map((r) => [r['id'], r]))

    // id=1: draft edit wins
    expect(byId[1]).toBeDefined()
    expect(byId[1]['title']).toBe('APPLE-edited')

    // id=2: tombstoned — absent
    expect(byId[2]).toBeUndefined()

    // id=3: canonical value untouched (no draft row for id=3 in d1)
    expect(byId[3]).toBeDefined()
    expect(byId[3]['title']).toBe('cherry')

    // id=4: draft insert surfaces
    expect(byId[4]).toBeDefined()
    expect(byId[4]['title']).toBe('date-new')
  })

  test('rows are returned in pk order', async () => {
    const rows = await tracked.withDraft('d1').from(todos).all()
    const ids = rows.map((r) => r['id'] as number)
    expect(ids).toEqual([1, 3, 4])
  })
})

// ---------------------------------------------------------------------------
// Test 2: Zero-overhead — canonical from().all() path is structurally untouched
// ---------------------------------------------------------------------------

describe('withDraft zero-overhead', () => {
  test('ZERO-OVERHEAD: canonical path lowers to byte-identical SQL as raw Drizzle (.toSQL() assertion)', () => {
    // This is the load-bearing zero-overhead proof from the spike (Seam A).
    // The canonical SelectBuilder must generate byte-identical SQL to a plain
    // Drizzle select — proving the draft seam never runs on the canonical path.
    const baseline = db.select().from(todos).toSQL()
    const trackedSql = tracked.from(todos).toSql()

    expect(trackedSql.sql).toBe(baseline.sql)
    expect(trackedSql.params).toEqual(baseline.params)
  })

  test('canonical from().all() returns all 3 unmodified rows', async () => {
    const rows = await tracked.from(todos).all()
    expect(rows).toHaveLength(3)
  })

  test('canonical from() returns a SelectBuilder, draft from() returns a DraftSelectBuilder', async () => {
    const canonicalBuilder = tracked.from(todos)
    const draftBuilder = tracked.withDraft('d1').from(todos)

    expect(canonicalBuilder).toBeInstanceOf(SelectBuilder)
    expect(draftBuilder).toBeInstanceOf(DraftSelectBuilder)
  })

  test('canonical read after draft read still sees original data', async () => {
    // Draft read should not mutate any state that affects the canonical path
    await tracked.withDraft('d1').from(todos).all()
    const canonical = await tracked.from(todos).all()
    expect(canonical).toHaveLength(3)
    const titles = (canonical as { title: string }[]).map((r) => r.title).sort()
    expect(titles).toEqual(['apple', 'banana', 'cherry'])
  })
})

// ---------------------------------------------------------------------------
// Test 3: App-agnostic — works for an arbitrary toy table (widgets)
// ---------------------------------------------------------------------------

describe('withDraft app-agnostic', () => {
  test('coalesce works for widgets table with same delta/insert pattern', async () => {
    const rows = await tracked.withDraft('dW').from(widgets).all()

    // Expected: id=1 (GEAR-edited), id=2 (canonical cog), id=3 (sprocket draft insert)
    expect(rows).toHaveLength(3)

    const byId = Object.fromEntries(rows.map((r) => [r['id'], r]))

    expect(byId[1]['name']).toBe('GEAR-edited')
    expect(byId[2]['name']).toBe('cog')
    expect(byId[3]['name']).toBe('sprocket')
  })

  test('a draft handle for a different draftId sees different delta', async () => {
    // Draft 'dW' edits widgets; 'd1' edits todos. Cross-table isolation.
    const todosRows = await tracked.withDraft('d1').from(todos).all()
    const widgetsRows = await tracked.withDraft('dW').from(widgets).all()

    // todos draft applies to todos only
    expect(todosRows.map((r) => r['id'])).toEqual([1, 3, 4])

    // widgets draft applies to widgets only
    expect(widgetsRows.map((r) => r['id'])).toEqual([1, 2, 3])
  })
})

// ---------------------------------------------------------------------------
// Test 4: tablesRead tracking
// ---------------------------------------------------------------------------

describe('withDraft tablesRead tracking', () => {
  test('after withDraft().from(todos).all(), tablesRead includes "todos"', async () => {
    expect(tracked.tablesRead.has('todos')).toBe(false)
    await tracked.withDraft('d1').from(todos).all()
    expect(tracked.tablesRead.has('todos')).toBe(true)
  })

  test('draft handle shares the same tablesRead set as the parent tracker', async () => {
    const draftHandle = tracked.withDraft('d1')
    // Before any call, both sets are the same reference
    expect(draftHandle.tablesRead).toBe(tracked.tablesRead)

    await draftHandle.from(todos).all()
    // The read was recorded on the shared set — visible from both handles
    expect(tracked.tablesRead.has('todos')).toBe(true)
    expect(draftHandle.tablesRead.has('todos')).toBe(true)
  })

  test('tablesRead does not include todos__draft (internal implementation detail)', async () => {
    await tracked.withDraft('d1').from(todos).all()
    // The coalesce joins todos__draft internally but we only expose the base table name
    expect(tracked.tablesRead.has('todos__draft')).toBe(false)
    expect(tracked.tablesRead.has('todos')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test 5: Edge cases
// ---------------------------------------------------------------------------

describe('withDraft edge cases', () => {
  test('empty draft (draftId with no rows) degenerates to full canonical read', async () => {
    // A draft ID with zero entries in __draft must not drop or corrupt canonical rows.
    const rows = await tracked.withDraft('nonexistent-draft').from(todos).all()
    expect(rows).toHaveLength(3)
    const ids = rows.map((r) => r['id'] as number).sort((a, b) => a - b)
    expect(ids).toEqual([1, 2, 3])
  })

  test('draftId with single-quote is passed as a bound parameter (no injection)', async () => {
    // A draftId containing a single-quote must not break the query.
    // With parameterization, the driver handles escaping; no SQL error should be thrown.
    // No rows in __draft match this draftId, so canonical rows are returned.
    const rows = await tracked.withDraft("d'injected").from(todos).all()
    expect(rows).toHaveLength(3)
  })

  test('where() throws to prevent silent auth/authz bypass', () => {
    expect(() =>
      tracked.withDraft('d1').from(todos).where({ column: 'id', op: 'eq', value: 1 }),
    ).toThrow('DraftSelectBuilder.where() is not yet implemented')
  })
})
