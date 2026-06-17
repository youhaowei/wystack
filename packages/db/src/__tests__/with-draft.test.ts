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
import {
  pgTable,
  pgSchema,
  integer,
  serial,
  timestamp as pgTimestamp,
  text as pgText,
  boolean as pgBoolean,
  primaryKey,
} from 'drizzle-orm/pg-core'
import {
  createTrackedDb,
  DraftSelectBuilder,
  SelectBuilder,
  normalizeExecuteRows,
} from '../tracked-db'

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

  test('where() then all() throws to prevent silent auth/authz bypass', async () => {
    // YW-121 made `where()` valid (it pins the PK for the write path), but a
    // FILTERED READ is still unsupported — the coalesce does not push `where`
    // down — so `.where().all()` throws rather than silently returning every row.
    await expect(
      tracked.withDraft('d1').from(todos).where({ column: 'id', op: 'eq', value: 1 }).all(),
    ).rejects.toThrow(/after .where.* is not supported|does not apply row filters/)
  })

  test('orderBy() throws (fail-loud, not a silent no-op)', () => {
    expect(() => tracked.withDraft('d1').from(todos).orderBy('id', 'desc')).toThrow(
      'DraftSelectBuilder.orderBy() is not yet implemented',
    )
  })

  test('limit() throws (fail-loud, not a silent no-op)', () => {
    expect(() => tracked.withDraft('d1').from(todos).limit(10)).toThrow(
      'DraftSelectBuilder.limit() is not yet implemented',
    )
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
