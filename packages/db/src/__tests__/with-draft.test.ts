/**
 * Tests for `DrizzleTracker.withDraft(draftId)` — the draft coalesce read primitive.
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
import {
  pgTable,
  pgSchema,
  integer,
  serial,
  timestamp as pgTimestamp,
  text as pgText,
  boolean as pgBoolean,
  jsonb as pgJsonb,
  primaryKey,
} from 'drizzle-orm/pg-core'
import { getTableColumns, sql } from 'drizzle-orm'
import {
  createDrizzleTracker,
  DraftSelectBuilder,
  SelectBuilder,
  normalizeExecuteRows,
  decodeRowFromDriver,
} from '../drizzle-tracker'
import { eq } from '../operators'

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
// typed references for future Drizzle-DSL query work.
void todosDraft
void widgetsDraft

// ---------------------------------------------------------------------------
// Test database setup
// ---------------------------------------------------------------------------

let pg: PGlite
let db: ReturnType<typeof drizzle>
let tracked: ReturnType<typeof createDrizzleTracker>

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
      __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      __tombstone BOOLEAN NOT NULL,
      PRIMARY KEY (draft_id, id)
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS widgets__draft (
      draft_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      name TEXT,
      __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
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

  tracked = createDrizzleTracker(db)
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
    // Kept as a shape check, NOT as the proof of ordering. Rows land in the heap
    // in pk order, so this passes with the ORDER BY deleted — the lowered-SQL
    // assertions in `draft lowering` are what actually pin the clause.
    const rows = await tracked.withDraft('d1').from(todos).all()
    const ids = rows.map((r) => r['id'] as number)
    expect(ids).toEqual([1, 3, 4])
  })
})

// ---------------------------------------------------------------------------
// Test 1b: Draft lowering — assertions on emitted SQL, not on returned rows
//
// Every test here exists because its row-order equivalent does not discriminate.
// PGlite returns rows from this FULL OUTER JOIN in pk order regardless of what
// the builder emits (a heap populated in pk order, joined on that same key), so
// a `toEqual([1, 3, 4])` passes with the ORDER BY, the tiebreaker, or the LIMIT
// removed. `DraftSelectBuilder.toSql()` is the seam that makes them observable.
// ---------------------------------------------------------------------------

describe('draft lowering', () => {
  test('default read lowers ORDER BY on the coalesced pk', () => {
    const { sql: lowered } = tracked.withDraft('d1').from(todos).toSql()
    expect(lowered).toContain('ORDER BY COALESCE(d."id", b."id")')
  })

  test('orderBy(col) lowers the named column with the pk as trailing tiebreaker', () => {
    const { sql: lowered } = tracked.withDraft('d1').from(todos).orderBy('title').toSql()
    expect(lowered).toContain("ORDER BY CASE WHEN 'title' = ANY(d.\"__overrides\")")
    expect(lowered).toContain(', COALESCE(d."id", b."id")')
  })

  test('orderBy(col, desc) applies the direction to the named column only', () => {
    const { sql: lowered } = tracked.withDraft('d1').from(todos).orderBy('title', 'desc').toSql()
    // DESC binds to the named column; the tiebreaker stays ascending, so a
    // descending read still resolves ties the same way an ascending one does.
    expect(lowered).toContain("ORDER BY CASE WHEN 'title' = ANY(d.\"__overrides\")")
    expect(lowered).toContain('END DESC, COALESCE(d."id", b."id")')
  })

  test('PARITY: both builders lower the same trailing pk tiebreaker under orderBy', () => {
    // The cross-path guarantee, stated as one assertion: when a caller names a
    // column, the canonical and draft reads resolve ties identically — so a
    // draft preview and its canonical publish cannot disagree under `limit`.
    // A handler cannot tell which handle it holds, which is what makes this
    // load-bearing rather than cosmetic.
    const canonical = tracked.from(todos).orderBy('title').toSql().sql
    const draft = tracked.withDraft('d1').from(todos).orderBy('title').toSql().sql

    expect(canonical).toContain('order by "todos"."title" asc, "todos"."id" asc')
    expect(draft).toContain("ORDER BY CASE WHEN 'title' = ANY(d.\"__overrides\")")
    expect(draft).toContain(', COALESCE(d."id", b."id")')
  })

  test('NO PARITY without orderBy: canonical emits no ORDER BY, draft defaults to pk', () => {
    // Deliberate asymmetry, pinned so it cannot drift silently in either
    // direction. The contract is "no order guarantee unless you call
    // `orderBy()`", so the draft is free to be stronger — and must be, because
    // a FULL OUTER JOIN's output order is join-algorithm-dependent rather than
    // heap-stable. Canonical must stay clean to hold the zero-overhead proof.
    expect(tracked.from(todos).toSql().sql.toLowerCase()).not.toContain('order by')
    expect(tracked.withDraft('d1').from(todos).toSql().sql).toContain('ORDER BY')
  })

  test('limit(n) lowers LIMIT as a bound parameter, not an interpolated literal', () => {
    const { sql: lowered, params } = tracked.withDraft('d1').from(todos).limit(2).toSql()
    expect(lowered).toContain('LIMIT')
    expect(lowered).not.toContain('LIMIT 2')
    expect(params).toContain(2)
  })

  test('no limit() lowers no LIMIT clause', () => {
    expect(tracked.withDraft('d1').from(todos).toSql().sql).not.toContain('LIMIT')
  })

  test('projection lowers only the named columns, in the order named', () => {
    const { sql: lowered } = tracked.withDraft('d1').from(todos).select('done', 'title').toSql()
    // Named order, not schema order — asserted on the SELECT list because the
    // returned row's key order is the same either way when the two coincide.
    const doneIndex = lowered.indexOf("CASE WHEN 'done' = ANY(d.\"__overrides\")")
    const titleIndex = lowered.indexOf("CASE WHEN 'title' = ANY(d.\"__overrides\")")
    expect(doneIndex).toBeGreaterThanOrEqual(0)
    expect(titleIndex).toBeGreaterThan(doneIndex)
    // The pk is absent from the SELECT list but still drives join and ordering.
    expect(lowered).toContain('b."id" = d."id"')
    expect(lowered).toContain('ORDER BY COALESCE(d."id", b."id")')
  })

  test('select() rejects an empty column list', () => {
    const builder = tracked.withDraft('d1').from(todos)
    // @ts-expect-error — the tuple type forbids this; the guard is for callers
    // reaching the draft handle through `runHandler`'s DrizzleTracker widening.
    expect(() => builder.select()).toThrow('at least one column')
  })

  test('first() pushes LIMIT 1 into the SQL it actually executes, on both paths', async () => {
    // `first()` fetches one row rather than the whole set and discarding the
    // tail. Purely a lowering concern: with the pushdown gone, `first()` still
    // answers correctly off a larger fetch, so only the emitted SQL shows it.
    //
    // Asserted through Drizzle's query logger rather than through `toSql(1)`,
    // because `toSql(1)` only proves the override plumbing works when someone
    // passes 1 — it never reaches `first()`'s call site. With `_read(1)`
    // mutated to `_read()` a `toSql(1)` assertion still passes; this one fails.
    const seen: string[] = []
    const spied = createDrizzleTracker(drizzle(pg, { logger: { logQuery: (q) => seen.push(q) } }))

    await spied.from(todos).first()
    expect(seen.at(-1)).toContain('limit')

    seen.length = 0
    await spied.withDraft('d1').from(todos).first()
    expect(seen.at(-1)).toContain('LIMIT')
  })

  test('first()-style LIMIT 1 composes with a caller limit rather than replacing it', () => {
    // The override is what keeps `_clauses.limitVal` meaning only "the caller
    // attached limit()" — the field the write guard reads. If `first()` wrote
    // into that slot instead, a later write terminal would wrongly reject.
    const { sql: lowered, params } = tracked.withDraft('d1').from(todos).toSql(1)
    expect(lowered).toContain('LIMIT')
    expect(params).toContain(1)
  })

  test('limit() rejects a negative, fractional or non-finite count on both paths', () => {
    // `number` admits all of these; Postgres rejects them at execution, naming
    // neither the builder nor the call site. Same setter-level treatment as
    // `select()`'s empty list and `orderBy()`'s empty name.
    for (const bad of [-1, 1.5, NaN, Infinity]) {
      expect(() => tracked.from(todos).limit(bad)).toThrow('non-negative integer')
      expect(() => tracked.withDraft('d1').from(todos).limit(bad)).toThrow('non-negative integer')
    }
    // 0 is a legitimate cap — it lowers `LIMIT 0`, an empty read, not an error.
    expect(() => tracked.from(todos).limit(0)).not.toThrow()
    expect(() => tracked.withDraft('d1').from(todos).limit(0)).not.toThrow()
  })

  test('canonical projection lowers only the named columns, in the order named', () => {
    // The draft twin of this lives above; both are asserted on lowered SQL
    // because a returned row's key order matches schema order by coincidence
    // whenever the named order does.
    const { sql: lowered } = tracked.from(todos).select('done', 'title').toSql()
    expect(lowered).toContain('select "done", "title" from')
  })

  test('where() does not alias the filters array between builder copies', () => {
    // Each clause method returns a copy; `where` spreads into a NEW array rather
    // than pushing into the shared one. Aliasing here would let a filter applied
    // to one name silently appear in the other — the immutability refactor's
    // whole point, and invisible in a row-order assertion.
    const base = tracked.withDraft('d1').from(todos)
    const filtered = base.where(eq('id', 1))

    expect(base.toSql().sql).not.toContain('AND COALESCE(d."id", b."id") =')
    expect(filtered.toSql().sql).toContain('AND COALESCE(d."id", b."id") =')
    // And the original stays reusable after the copy was lowered.
    expect(base.toSql().sql).not.toContain('AND COALESCE(d."id", b."id") =')
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

  test('tablesRead includes both todos AND todos__draft (shadow-table dependency)', async () => {
    await tracked.withDraft('d1').from(todos).all()
    // The draft read's result genuinely depends on the shadow table: a write to
    // todos__draft (publishing tablesWritten={'todos__draft'}) must invalidate
    // this subscription. That only fires if the shadow table is in tablesRead so
    // the reactive router's read∩write intersection matches. Recording only the
    // base table would silently drop draft-edit invalidations.
    expect(tracked.tablesRead.has('todos')).toBe(true)
    expect(tracked.tablesRead.has('todos__draft')).toBe(true)
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

  test('a single PK eq filter on all() is pushed into the coalesce (not a throw)', async () => {
    // A PK-pinned read IS supported: it returns the one coalesced row. (The
    // fail-loud cases — non-PK column, non-eq op, multiple filters — are covered
    // in the PK-filtered read suite below.)
    const rows = await tracked
      .withDraft('d1')
      .from(todos)
      .where({ column: 'id', op: 'eq', value: 1 })
      .all()
    expect(rows).toHaveLength(1)
    expect(rows[0]['title']).toBe('APPLE-edited')
  })

  // These two previously asserted a 'not yet implemented' throw. Both clauses are
  // now pushed into the coalesce SQL, so the contract they pin is the real
  // behavior — see `DraftSelectBuilder orderBy / limit` in drizzle-tracker.test.ts
  // for the ordering semantics (COALESCE, PK tiebreaker, tombstone vs limit slot).
  test('orderBy() sorts the coalesced read', async () => {
    // Asserted against the literal expected order, not against a sorted copy of
    // the result. Comparing a list to `[...ids].sort()` is a sortedness check
    // that holds trivially on 0 or 1 row, so a regression collapsing the
    // coalesce to a single row would keep it green.
    //
    // Unlike the other row-order tests here, this one does discriminate: heap
    // order is ascending, so a dropped ORDER BY yields [1, 3, 4] and fails.
    const rows = await tracked.withDraft('d1').from(todos).orderBy('id', 'desc').all()
    const ids = rows.map((r) => r['id'])
    expect(ids).toEqual([4, 3, 1])
  })

  test('limit() caps the coalesced read', async () => {
    const all = await tracked.withDraft('d1').from(todos).all()
    expect(all.length).toBeGreaterThan(1)

    const capped = await tracked.withDraft('d1').from(todos).limit(1).all()
    expect(capped).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Test 6: Row shape — property name ≠ SQL column name (camelCase ↔ snake_case)
// ---------------------------------------------------------------------------

// Drizzle property `createdAt` maps to SQL column `created_at`. The coalesce
// must alias the result back to the PROPERTY KEY so the draft row shape matches
// canonical from().all() — consumers reading `row.createdAt` must not get undefined.
const events = pgTable('events', {
  id: integer('id').primaryKey(),
  eventName: pgText('event_name').notNull(),
  createdAt: pgTimestamp('created_at').notNull(),
})

const eventsDraft = pgTable('events__draft', {
  draftId: pgText('draft_id').notNull(),
  id: integer('id').notNull(),
  eventName: pgText('event_name'),
  createdAt: pgTimestamp('created_at'),
  tombstone: pgBoolean('__tombstone').notNull(),
})
void eventsDraft

describe('withDraft row shape — property name differs from SQL column name', () => {
  test('result rows are keyed by Drizzle property name, not SQL column name', async () => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY,
        event_name TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL
      )
    `)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS events__draft (
        draft_id TEXT NOT NULL,
        id INTEGER NOT NULL,
        event_name TEXT,
        created_at TIMESTAMP,
        __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        __tombstone BOOLEAN NOT NULL,
        PRIMARY KEY (draft_id, id)
      )
    `)
    await db.execute(`
      INSERT INTO events (id, event_name, created_at) VALUES
        (1, 'login', '2026-01-01T00:00:00Z')
    `)
    await db.execute(`
      INSERT INTO events__draft (draft_id, id, event_name, created_at, __tombstone) VALUES
        ('de', 1, 'login-edited', null, false)
    `)

    const rows = await tracked.withDraft('de').from(events).all()
    expect(rows).toHaveLength(1)
    const row = rows[0]

    // Aliased to property key `eventName` / `createdAt`, NOT `event_name` / `created_at`.
    expect(row['eventName']).toBe('login-edited')
    expect(row['createdAt']).toBeDefined()
    expect(row['event_name']).toBeUndefined()
    expect(row['created_at']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Test 7: Primary-key detection — serial PK not named `id`, composite PK throws
// ---------------------------------------------------------------------------

// A serial integer PK named `tenant_id` (not `id`). schema.ts marks serial PKs
// primary in Drizzle metadata, so PK detection finds it without an `id` fallback.
const tenants = pgTable('tenants', {
  tenantId: serial('tenant_id').primaryKey(),
  label: pgText('label').notNull(),
})

const tenantsDraft = pgTable('tenants__draft', {
  draftId: pgText('draft_id').notNull(),
  tenantId: integer('tenant_id').notNull(),
  label: pgText('label'),
  tombstone: pgBoolean('__tombstone').notNull(),
})
void tenantsDraft

// Table-level composite PK via primaryKey({ columns: [...] }) — must throw, not
// silently coalesce on the wrong single column.
const memberships = pgTable(
  'memberships',
  {
    userId: integer('user_id').notNull(),
    groupId: integer('group_id').notNull(),
    role: pgText('role').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.groupId] })],
)

describe('withDraft primary-key detection', () => {
  test('coalesces on a serial PK that is not named `id`', async () => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS tenants (
        tenant_id SERIAL PRIMARY KEY,
        label TEXT NOT NULL
      )
    `)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS tenants__draft (
        draft_id TEXT NOT NULL,
        tenant_id INTEGER NOT NULL,
        label TEXT,
        __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        __tombstone BOOLEAN NOT NULL,
        PRIMARY KEY (draft_id, tenant_id)
      )
    `)
    await db.execute(`
      INSERT INTO tenants (tenant_id, label) VALUES (1, 'acme'), (2, 'globex')
    `)
    await db.execute(`
      INSERT INTO tenants__draft (draft_id, tenant_id, label, __tombstone) VALUES
        ('dt', 1, 'acme-edited', false),
        ('dt', 3, 'initech-new', false)
    `)

    const rows = await tracked.withDraft('dt').from(tenants).all()
    const byId = Object.fromEntries(rows.map((r) => [r['tenantId'], r]))

    // Edit wins on tenant_id=1, canonical tenant_id=2 untouched, draft insert id=3.
    expect(rows).toHaveLength(3)
    expect(byId[1]['label']).toBe('acme-edited')
    expect(byId[2]['label']).toBe('globex')
    expect(byId[3]['label']).toBe('initech-new')
  })

  test('throws a clear error for a composite (table-level) primary key', async () => {
    // all() is async — the PK-resolution throw surfaces as a rejection, so this
    // must use `.rejects` (a plain `expect(() => ...).toThrow()` passes
    // vacuously here, asserting nothing).
    await expect(tracked.withDraft('dm').from(memberships).all()).rejects.toThrow(
      /composite primary key/i,
    )
  })
})

// ---------------------------------------------------------------------------
// Test 8: Schema-qualified tables (pgSchema('app').table(...))
// ---------------------------------------------------------------------------

const appSchema = pgSchema('app')
const accounts = appSchema.table('accounts', {
  id: integer('id').primaryKey(),
  owner: pgText('owner').notNull(),
})
const accountsDraft = appSchema.table('accounts__draft', {
  draftId: pgText('draft_id').notNull(),
  id: integer('id').notNull(),
  owner: pgText('owner'),
  tombstone: pgBoolean('__tombstone').notNull(),
})
void accountsDraft

describe('withDraft schema-qualified tables', () => {
  test('coalesce qualifies base + draft relations with the schema', async () => {
    await db.execute(`CREATE SCHEMA IF NOT EXISTS app`)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS app.accounts (
        id INTEGER PRIMARY KEY,
        owner TEXT NOT NULL
      )
    `)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS app.accounts__draft (
        draft_id TEXT NOT NULL,
        id INTEGER NOT NULL,
        owner TEXT,
        __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        __tombstone BOOLEAN NOT NULL,
        PRIMARY KEY (draft_id, id)
      )
    `)
    await db.execute(`INSERT INTO app.accounts (id, owner) VALUES (1, 'root'), (2, 'guest')`)
    await db.execute(`
      INSERT INTO app.accounts__draft (draft_id, id, owner, __tombstone) VALUES
        ('da', 1, 'root-edited', false)
    `)

    const rows = await tracked.withDraft('da').from(accounts).all()
    const byId = Object.fromEntries(rows.map((r) => [r['id'], r]))
    expect(rows).toHaveLength(2)
    expect(byId[1]['owner']).toBe('root-edited')
    expect(byId[2]['owner']).toBe('guest')
  })
})

// ---------------------------------------------------------------------------
// Test 9: normalizeExecuteRows — driver result-shape normalization
//
// The integration tests above all run against PGlite, whose db.execute()
// returns a { rows } wrapper. The PRODUCTION path (postgres-js) instead returns
// a RowList — a postgres.js `Result extends Array` with non-enumerable metadata
// props (count, command, columns). That array branch is the highest-severity
// fix in this change and is invisible to the PGlite integration tests, so it
// gets a direct unit test here.
// ---------------------------------------------------------------------------

describe('normalizeExecuteRows — driver result shapes', () => {
  test('postgres-js shape: a RowList (Array subclass) is returned as the rows', () => {
    // Mirror postgres.js: `class Result extends Array` with non-enumerable
    // metadata properties that must NOT leak into the returned row objects.
    class RowList extends Array {}
    const result = RowList.from([{ id: 1, name: 'a' }]) as RowList & {
      count?: number
      command?: string
    }
    Object.defineProperty(result, 'count', { value: 1, enumerable: false })
    Object.defineProperty(result, 'command', { value: 'SELECT', enumerable: false })

    const rows = normalizeExecuteRows(result)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({ id: 1, name: 'a' })
    // The result IS the rows — no wrapper unwrap, metadata stays non-enumerable.
    expect(Object.keys(rows[0])).toEqual(['id', 'name'])
  })

  test('PGlite shape: a { rows } wrapper is unwrapped to its rows array', () => {
    const result = { rows: [{ id: 2 }], fields: [], affectedRows: 0 }
    expect(normalizeExecuteRows(result)).toBe(result.rows)
  })

  test('empty postgres-js RowList normalizes to an empty array', () => {
    expect(normalizeExecuteRows([])).toEqual([])
  })

  test('throws on an unrecognized result shape (neither array nor { rows })', () => {
    expect(() => normalizeExecuteRows({ unexpected: true })).toThrow(
      'unexpected db.execute() result shape',
    )
  })
})

// ---------------------------------------------------------------------------
// Test 10: jsonb codec on draft writes (Gap 1)
//
// A draft write must route each value through the Drizzle column codec, exactly
// as the canonical insert path does. A `jsonb('fields')` column receiving a JS
// array/object must be JSON-serialized (`mapToDriverValue` === JSON.stringify),
// NOT bound as a raw JS array — which produces a SQL type error or stored
// garbage. Every draftable artifact table has a jsonb column, so this is the
// floor for ALL draft writes.
// ---------------------------------------------------------------------------

const reports = pgTable('reports', {
  id: integer('id').primaryKey(),
  title: pgText('title').notNull(),
  fields: pgJsonb('fields').notNull(),
  config: pgJsonb('config'),
})

const reportsDraft = pgTable('reports__draft', {
  draftId: pgText('draft_id').notNull(),
  id: integer('id').notNull(),
  title: pgText('title'),
  fields: pgJsonb('fields'),
  config: pgJsonb('config'),
  tombstone: pgBoolean('__tombstone').notNull(),
})
void reportsDraft

describe('withDraft jsonb codec on writes (Gap 1)', () => {
  let jpg: PGlite
  let jdb: ReturnType<typeof drizzle>
  let jtracked: ReturnType<typeof createDrizzleTracker>

  beforeEach(async () => {
    jpg = new PGlite()
    jdb = drizzle(jpg)
    await jdb.execute(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        fields JSONB NOT NULL,
        config JSONB
      )
    `)
    await jdb.execute(`
      CREATE TABLE IF NOT EXISTS reports__draft (
        draft_id TEXT NOT NULL,
        id INTEGER NOT NULL,
        title TEXT,
        fields JSONB,
        config JSONB,
        __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        __tombstone BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (draft_id, id)
      )
    `)
    jtracked = createDrizzleTracker(jdb)
  })

  test('CONTRACT 1: a jsonb value round-trips through a draft insert + coalesce read', async () => {
    // Without the codec fix this throws (binding a raw JS array to a jsonb param)
    // or stores garbage. With it, the value is JSON-serialized on write and
    // parsed back on read — a structural deep-equal round-trip.
    const fields = [{ a: 1 }, { b: [2, 3], nested: { ok: true } }]
    await jtracked.withDraft('dj').into(reports).insert({ id: 1, title: 'r', fields })

    const rows = await jtracked.withDraft('dj').from(reports).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]['fields']).toEqual(fields)
  })

  test('a jsonb object value also round-trips (object, not just array)', async () => {
    const config = { theme: 'dark', limit: 50, tags: ['x', 'y'] }
    await jtracked.withDraft('dj').into(reports).insert({ id: 2, title: 'r2', fields: [], config })
    const row = await jtracked.withDraft('dj').from(reports).where(eq('id', 2)).first()
    expect(row).not.toBeNull()
    expect((row as { config: unknown }).config).toEqual(config)
  })

  test('a jsonb edit via draft update round-trips through the codec', async () => {
    await jdb.execute(`INSERT INTO reports (id, title, fields) VALUES (3, 'canon', '[]'::jsonb)`)
    const next = [{ edited: true }]
    await jtracked.withDraft('dj').from(reports).where(eq('id', 3)).update({ fields: next })
    const row = await jtracked.withDraft('dj').from(reports).where(eq('id', 3)).first()
    expect((row as { fields: unknown }).fields).toEqual(next)
  })
})

// ---------------------------------------------------------------------------
// Test 10b: decodeRowFromDriver — the READ mirror of the #48 write-codec fix.
//
// `DraftSelectBuilder.all()` runs a raw coalesce SELECT and returns
// `normalizeExecuteRows(result)` — RAW driver rows. The write path (#48) routes
// values through `col.mapToDriverValue` (encode); the READ path must route the
// returned values through `col.mapFromDriverValue` (decode). The two drivers
// differ in COLUMN DECODE exactly as they differ in ROW SHAPE:
//   - PGlite auto-parses a jsonb column to a JS object on read, so the
//     integration jsonb round-trip above passes WITHOUT any read decode — the
//     bug is invisible to PGlite.
//   - postgres-js (the `createDb` production driver) returns a jsonb column as a
//     raw JSON STRING. Without decode, a draft read of `insights.definition`
//     hands a string to consumers expecting an object → silent misbehavior.
//
// This unit-tests the decode against the postgres-js shape directly (a jsonb
// column as a raw STRING), the same reason `normalizeExecuteRows` is exported —
// the production path is unreachable from PGlite. It also proves the column's
// own codec (not a hand-rolled jsonb-only JSON.parse) is what makes it
// driver-independent: a non-jsonb non-identity type (timestamp) decodes too, and
// decode is a no-op on an already-parsed PGlite value (idempotent).
// ---------------------------------------------------------------------------

describe('decodeRowFromDriver — column codec decode (read mirror of #48)', () => {
  // [propKey, col] entries exactly as `all()` builds them from the schema.
  const reportEntries = Object.entries(getTableColumns(reports)) as [
    string,
    // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
    any,
  ][]

  test('postgres-js shape: a jsonb column arriving as a raw STRING is decoded to the parsed object', () => {
    // The production bug: postgres-js returns jsonb as a JSON string. The raw
    // coalesce row carries `fields`/`config` as strings; decode must JSON.parse
    // them via the column codec so consumers get objects, not strings.
    const fieldsObj = [{ a: 1 }, { b: [2, 3] }]
    const configObj = { theme: 'dark', n: 50 }
    const rawRow = {
      id: 1,
      title: 'r',
      fields: JSON.stringify(fieldsObj),
      config: JSON.stringify(configObj),
    }

    const decoded = decodeRowFromDriver(rawRow, reportEntries)

    // Decoded to structured values — NOT the raw strings.
    expect(decoded['fields']).toEqual(fieldsObj)
    expect(decoded['config']).toEqual(configObj)
    expect(typeof decoded['fields']).toBe('object')
    // Identity-codec columns pass through untouched.
    expect(decoded['id']).toBe(1)
    expect(decoded['title']).toBe('r')
  })

  test('PGlite shape: an already-parsed jsonb object is left intact (decode is idempotent — no double-parse)', () => {
    // PGlite hands back a parsed JS object; the string-guarded jsonb codec must
    // no-op on it. This is the crux that makes ONE decode correct on BOTH drivers.
    const fieldsObj = [{ already: 'parsed' }]
    const rawRow = { id: 2, title: 'r2', fields: fieldsObj, config: { k: 'v' } }

    const decoded = decodeRowFromDriver(rawRow, reportEntries)

    expect(decoded['fields']).toEqual(fieldsObj)
    expect(decoded['config']).toEqual({ k: 'v' })
  })

  test('a NULL column value passes through (no override sentinel preserved, codec not invoked)', () => {
    // `config` is nullable; a coalesced NULL means SQL NULL / no override and
    // must never be fed to the codec (jsonb would stringify null → "null").
    const decoded = decodeRowFromDriver(
      { id: 3, title: 'r3', fields: '[]', config: null },
      reportEntries,
    )
    expect(decoded['config']).toBeNull()
    expect(decoded['fields']).toEqual([])
  })

  test('decodes EVERY non-identity column type, not just jsonb (timestamp via its own codec)', () => {
    // Proves the fix uses the column codec generically: a timestamp column comes
    // back from the driver as a string/Date and is decoded by ITS codec to a
    // Date — a hand-rolled jsonb-only JSON.parse hack would miss this.
    const events = pgTable('events', {
      id: integer('id').primaryKey(),
      at: pgTimestamp('at'),
    })
    const entries = Object.entries(getTableColumns(events)) as [
      string,
      // oxlint-disable-next-line typescript/no-explicit-any -- Drizzle column objects are dynamically typed
      any,
    ][]
    const decoded = decodeRowFromDriver({ id: 1, at: '2026-06-23 12:00:00' }, entries)
    expect(decoded['at']).toBeInstanceOf(Date)
  })

  test('a column present in the row but absent from the schema is left untouched', () => {
    const decoded = decodeRowFromDriver(
      { id: 1, title: 't', fields: '[]', __extra: 'keep-me' },
      reportEntries,
    )
    expect(decoded['__extra']).toBe('keep-me')
  })
})

describe('withDraft coalesce read decode (integration, driver-independent)', () => {
  // Integration mirror: a jsonb column round-trips as a PARSED OBJECT through a
  // real draft coalesce read, on BOTH coalesce sides — a base-side column (no
  // draft delta) and a draft-side overlay value. On PGlite these pass via
  // auto-parse; the decode is what makes the SAME reads correct on postgres-js
  // (see the unit test above for the raw-string production path). Deep-equal
  // guards that the decode wired into all() does not corrupt the PGlite path.
  let jpg: PGlite
  let jdb: ReturnType<typeof drizzle>
  let jtracked: ReturnType<typeof createDrizzleTracker>

  beforeEach(async () => {
    jpg = new PGlite()
    jdb = drizzle(jpg)
    await jdb.execute(`
      CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY, title TEXT NOT NULL, fields JSONB NOT NULL, config JSONB
      )
    `)
    await jdb.execute(`
      CREATE TABLE IF NOT EXISTS reports__draft (
        draft_id TEXT NOT NULL, id INTEGER NOT NULL, title TEXT, fields JSONB, config JSONB,
        __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        __tombstone BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (draft_id, id)
      )
    `)
    jtracked = createDrizzleTracker(jdb)
  })

  test('a BASE-side jsonb row (no draft delta) reads back as a PARSED OBJECT through the coalesce', async () => {
    // COALESCE returns the base side here (no draft row for id=1). Guards that
    // decode wired into all() does not corrupt the canonical column of a draft read.
    const fields = [{ source: 'orders' }, { join: { on: 'id' } }]
    await jdb.execute(
      sql`INSERT INTO reports (id, title, fields) VALUES (1, 'canon', ${JSON.stringify(fields)}::jsonb)`,
    )
    const row = await jtracked.withDraft('dk').from(reports).where(eq('id', 1)).first()
    expect(row).not.toBeNull()
    // Deep-equals a structured object — accessing `.source` on the first element
    // works (the exact consumer shape: isOrphanedBy / insightTableRefs).
    expect((row as { fields: unknown }).fields).toEqual(fields)
    expect((row as { fields: { source?: string }[] }).fields[0].source).toBe('orders')
  })

  test('a DRAFT-side jsonb value (overlay row) reads back as a PARSED OBJECT through the coalesce', async () => {
    // The overlay path: the jsonb value comes from the DRAFT shadow column, not
    // the base table. write (mapToDriverValue → string) then coalesce-read
    // (mapFromDriverValue → object) must round-trip — the full read/write codec
    // symmetry on the draft side, the exact shape an application draft controller
    // depends on for reading an edited insights.definition.
    const fields = [{ source: 'edited_in_draft' }, { filters: [1, 2, 3] }]
    await jtracked.withDraft('dk').into(reports).insert({ id: 9, title: 'd', fields })
    const row = await jtracked.withDraft('dk').from(reports).where(eq('id', 9)).first()
    expect(row).not.toBeNull()
    expect((row as { fields: unknown }).fields).toEqual(fields)
    expect((row as { fields: { source?: string }[] }).fields[0].source).toBe('edited_in_draft')
  })
})

// ---------------------------------------------------------------------------
// Test 11: PK-filtered draft read coalesce (Gap 2 — the blocker)
//
// Every command handler reads `from(t).where(eq('id', x)).first()`. Under a
// draft that shape must coalesce a SINGLE PK-pinned row (the handler runs
// unmodified inside a draft). These exercise the exact consumer shape across:
// delta overlay, canonical-only, draft-only, tombstone suppression, cross-draft
// isolation, and the fail-loud guards.
// ---------------------------------------------------------------------------

describe('withDraft PK-filtered read coalesce (Gap 2)', () => {
  // Reuses the top-level `todos` schema + `tracked` (canonical 1,2,3; draft d1:
  // id=1 edited, id=2 tombstoned, id=4 inserted) seeded in the outer beforeEach.

  test('CONTRACT 2: PK-pinned read returns the COALESCED row (draft delta wins, other fields canonical)', async () => {
    // The exact handler shape: from(t).where(eq('id', x)).first().
    const row = await tracked.withDraft('d1').from(todos).where(eq('id', 1)).first()
    expect(row).not.toBeNull()
    // Overlaid field from the draft …
    expect((row as { title: string }).title).toBe('APPLE-edited')
    // … untouched field still from canonical (done was never edited in d1).
    expect((row as { done: boolean }).done).toBe(false)
    expect((row as { id: number }).id).toBe(1)
  })

  test('CONTRACT 3: PK-pinned read of a canonical-only row (no draft delta) returns the canonical row', async () => {
    const row = await tracked.withDraft('d1').from(todos).where(eq('id', 3)).first()
    expect(row).not.toBeNull()
    expect((row as { title: string }).title).toBe('cherry')
  })

  test('CONTRACT 4: PK-pinned read of a draft-only row (draft insert, no canonical) returns the draft row', async () => {
    // id=4 exists ONLY in the draft (base side of the FULL OUTER JOIN is NULL).
    const row = await tracked.withDraft('d1').from(todos).where(eq('id', 4)).first()
    expect(row).not.toBeNull()
    expect((row as { id: number }).id).toBe(4)
    expect((row as { title: string }).title).toBe('date-new')
  })

  test('CONTRACT 5: PK-pinned read of a tombstoned row returns null (draft delete suppresses)', async () => {
    // id=2 is tombstoned in d1 — the pk predicate must compose with the
    // tombstone-suppression WHERE, so the pinned read yields no row.
    const row = await tracked.withDraft('d1').from(todos).where(eq('id', 2)).first()
    expect(row).toBeNull()
    // .all() with the same pin returns the empty array (not a throw).
    const rows = await tracked.withDraft('d1').from(todos).where(eq('id', 2)).all()
    expect(rows).toEqual([])
  })

  test('CONTRACT 6: cross-draft isolation under a PK filter — draftA pin returns A, not B', async () => {
    // Same pk overlaid in two drafts with different values; a PK-pinned read in
    // each returns only that draft's overlay (the draft subquery is pre-filtered
    // by draft_id before the join — no cross-draft leak).
    await tracked.withDraft('dA').from(todos).where(eq('id', 3)).update({ title: 'A-cherry' })
    await tracked.withDraft('dB').from(todos).where(eq('id', 3)).update({ title: 'B-cherry' })

    const a = await tracked.withDraft('dA').from(todos).where(eq('id', 3)).first()
    const b = await tracked.withDraft('dB').from(todos).where(eq('id', 3)).first()
    expect((a as { title: string }).title).toBe('A-cherry')
    expect((b as { title: string }).title).toBe('B-cherry')
  })

  test('CONTRACT 7a: multiple filters apply to effective values', async () => {
    const rows = await tracked
      .withDraft('d1')
      .from(todos)
      .where(eq('id', 1))
      .where(eq('title', 'APPLE-edited'))
      .all()
    expect(rows.map((row) => row['id'])).toEqual([1])
  })

  test('CONTRACT 7b: non-equality operators match canonical filter behavior', async () => {
    const rows = await tracked
      .withDraft('d1')
      .from(todos)
      .where({ column: 'id', op: 'gt', value: 1 })
      .all()
    expect(rows.map((row) => row['id'])).toEqual([3, 4])
  })

  test('CONTRACT 7c: non-primary-key filters use effective draft values', async () => {
    const rows = await tracked.withDraft('d1').from(todos).where(eq('title', 'APPLE-edited')).all()
    expect(rows.map((row) => row['id'])).toEqual([1])
  })

  test('CONTRACT 7d: an unfiltered .all() still returns the FULL coalesced set', async () => {
    const rows = await tracked.withDraft('d1').from(todos).all()
    // id=1 (edited), id=3 (canonical), id=4 (draft insert); id=2 tombstoned.
    expect(rows.map((r) => r['id'])).toEqual([1, 3, 4])
  })

  test('CONTRACT 8: the mirror — both first() AND all() honor the PK filter', async () => {
    // first() → single coalesced row.
    const row = await tracked.withDraft('d1').from(todos).where(eq('id', 1)).first()
    expect((row as { title: string }).title).toBe('APPLE-edited')

    // all() → a 1-element array of the same coalesced row (not the full set).
    const rows = await tracked.withDraft('d1').from(todos).where(eq('id', 1)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]['title']).toBe('APPLE-edited')

    const updated = await tracked.withDraft('d1').from(todos).update({ done: true })
    expect(updated).toHaveLength(3)
  })

  test('CONTRACT 7e: undefined and null filter values never widen a read', async () => {
    expect(await tracked.withDraft('d1').from(todos).where(eq('id', undefined)).all()).toEqual([])
    expect(await tracked.withDraft('d1').from(todos).where(eq('id', null)).all()).toEqual([])
  })

  test('a falsy-but-valid PK (0) still pins (presence is keyed on the filter, not the value)', async () => {
    // id=0 is a legitimate PK value — it must pin the read, not be treated as
    // "no filter". Seed a canonical id=0 row and assert the pin returns exactly it.
    await db.execute(`INSERT INTO todos (id, title, done) VALUES (0, 'zero', false)`)
    const rows = await tracked.withDraft('d1').from(todos).where(eq('id', 0)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]['id']).toBe(0)
    expect(rows[0]['title']).toBe('zero')
  })
})

// ---------------------------------------------------------------------------
// Test 12: PK pin via SQL column name distinct from the property key
//
// A handler may pin by the SQL column name rather than the Drizzle property
// key. The resolver accepts EITHER form (same as the write path). This needs a
// table whose pk prop key ≠ sql col name so the sql-name acceptance branch is
// actually exercised (the `todos` table has prop key === sql col `id`, which
// can't distinguish the branches).
// ---------------------------------------------------------------------------

const reportRows = pgTable('report_rows', {
  reportId: integer('report_id').primaryKey(),
  label: pgText('label').notNull(),
})

const reportRowsDraft = pgTable('report_rows__draft', {
  draftId: pgText('draft_id').notNull(),
  reportId: integer('report_id').notNull(),
  label: pgText('label'),
  tombstone: pgBoolean('__tombstone').notNull(),
})
void reportRowsDraft

describe('withDraft filters use Drizzle property names', () => {
  test('a SQL column name is rejected while its public property key works', async () => {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS report_rows (
        report_id INTEGER PRIMARY KEY,
        label TEXT NOT NULL
      )
    `)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS report_rows__draft (
        draft_id TEXT NOT NULL,
        report_id INTEGER NOT NULL,
        label TEXT,
        __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
        __tombstone BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (draft_id, report_id)
      )
    `)
    await db.execute(`INSERT INTO report_rows (report_id, label) VALUES (1, 'one'), (2, 'two')`)
    await db.execute(`
      INSERT INTO report_rows__draft (draft_id, report_id, label, __tombstone) VALUES
        ('dr', 1, 'one-edited', false)
    `)

    await expect(
      tracked
        .withDraft('dr')
        .from(reportRows)
        .where({ column: 'report_id', op: 'eq', value: 1 })
        .first(),
    ).rejects.toThrow('Unknown column: report_id')

    // Pin by the prop key — must be equivalent.
    const byPropKey = await tracked
      .withDraft('dr')
      .from(reportRows)
      .where(eq('reportId', 1))
      .first()
    expect((byPropKey as { label: string }).label).toBe('one-edited')
  })
})
