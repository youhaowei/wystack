import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema } from '../schema'
import { text, int, boolean, uuid } from '../dsl'
import { eq } from '../operators'
import { createDrizzleTracker, resetTracking } from '../drizzle-tracker'
import { pgTable, text as pgText, integer } from 'drizzle-orm/pg-core'
import { table } from '../table'
import { draftChangesTableDdl } from './draft-storage.fixture'
import { ensureRowRevisionStorage } from '../row-revisions'
import { compareRowRevisionRows } from '../row-revisions'
import { noTenantScope } from '../tracker-core'

const schema = defineSchema({
  todos: table({
    id: int.primaryKey(),
    title: text,
    done: boolean,
  }).draftable(),
  tags: table({
    id: int.primaryKey(),
    label: text,
  }),
  versioned_todos: table({
    id: int.primaryKey(),
    title: text,
    revision: int,
  }).revision('revision'),
  versioned_uuid_todos: table({
    id: uuid.primaryKey().defaultRandom(),
    title: text,
    revision: int,
  }).revision('revision'),
})

const unicodeRevisionRows = pgTable('unicode_revision_rows', {
  id: pgText('id').primaryKey(),
})

let pg: PGlite
let db: ReturnType<typeof drizzle>
let tracked: ReturnType<typeof createDrizzleTracker>

beforeEach(async () => {
  pg = new PGlite()
  db = drizzle(pg)

  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS versioned_uuid_todos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS versioned_todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1
    )
  `)
  await ensureRowRevisionStorage(db)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tags (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL
    )
  `)
  // `label` carries a DEFERRABLE INITIALLY DEFERRED unique constraint so a
  // duplicate is accepted by the INSERT and only rejected at COMMIT — this is
  // how we exercise the commit-time-failure rollback path.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS deferred_tags (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      CONSTRAINT deferred_tags_label_uniq UNIQUE (label) DEFERRABLE INITIALLY DEFERRED
    )
  `)
  await db.execute('DELETE FROM todos')
  await db.execute('DELETE FROM tags')
  await db.execute('DELETE FROM deferred_tags')

  tracked = createDrizzleTracker(db)
})

afterEach(async () => {
  await pg.close()
})

describe('DrizzleTracker', () => {
  /** Lock keys use PostgreSQL C-collation byte order, including where UTF-16 ordering differs. */
  test('revision lock ordering matches PostgreSQL C collation for non-ASCII identities', () => {
    const rows = [{ id: '\u{10000}' }, { id: '\uE000' }]

    rows.sort((left, right) =>
      compareRowRevisionRows(unicodeRevisionRows, noTenantScope, left, right),
    )

    // UTF-16 code-unit ordering puts U+10000 first. UTF-8 byte ordering, like
    // PostgreSQL COLLATE "C", puts U+E000 first.
    expect(rows).toEqual([{ id: '\uE000' }, { id: '\u{10000}' }])
  })

  test('insert records tablesWritten', async () => {
    await tracked.into(schema.todos).insert({ title: 'Test', done: false })
    expect(tracked.tablesWritten.has('todos')).toBe(true)
  })

  test('insert returns the inserted row', async () => {
    const rows = await tracked.into(schema.todos).insert({ title: 'Test', done: false })
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Test')
    expect(rows[0].done).toBe(false)
    expect(rows[0].id).toBeGreaterThan(0)
  })

  /** A generated serial key is materialized once and becomes the identity of the same revision ledger row. */
  test('revisioned inserts materialize generated primary keys before allocating ledger tokens', async () => {
    const first = await tracked.into(schema.versioned_todos).insert({ title: 'first' })
    const second = await tracked.into(schema.versioned_todos).insert({ title: 'second' })

    expect(first).toEqual([{ id: 1, title: 'first', revision: 1 }])
    expect(second).toEqual([{ id: 2, title: 'second', revision: 1 }])
    const ledger = await db.execute(
      `SELECT row_key_text, revision FROM wystack_row_revisions
       WHERE table_key = 'versioned_todos' ORDER BY row_key_text`,
    )
    expect(ledger.rows).toEqual([
      { row_key_text: '1', revision: 1 },
      { row_key_text: '2', revision: 1 },
    ])
  })

  /** A generated UUID is shared by the inserted row and its revision ledger entry, never generated twice. */
  test('revisioned UUID defaults are materialized once for the ledger and inserted row', async () => {
    const [inserted] = await tracked
      .into(schema.versioned_uuid_todos)
      .insert({ title: 'generated uuid' })

    expect(inserted.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    const ledger = await db.execute(
      `SELECT row_key_text FROM wystack_row_revisions
       WHERE table_key = 'versioned_uuid_todos'`,
    )
    expect(ledger.rows).toEqual([{ row_key_text: inserted.id }])
  })

  test('a failed insert does not record tablesWritten', async () => {
    await tracked.into(schema.todos).insert({ id: 1, title: 'first', done: false })
    tracked = resetTracking(tracked)

    await expect(
      tracked.into(schema.todos).insert({ id: 1, title: 'duplicate', done: false }),
    ).rejects.toThrow()
    expect(tracked.tablesWritten.size).toBe(0)
  })

  test('select all records tablesRead', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    tracked = resetTracking(tracked)

    const rows = await tracked.from(schema.todos).all()
    expect(tracked.tablesRead.has('todos')).toBe(true)
    expect(rows).toHaveLength(1)
  })

  test('select with where filter', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    await tracked.into(schema.todos).insert({ title: 'B', done: true })
    tracked = resetTracking(tracked)

    const rows = await tracked.from(schema.todos).where(eq('done', true)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('B')
  })

  test('select with limit', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    await tracked.into(schema.todos).insert({ title: 'B', done: false })
    await tracked.into(schema.todos).insert({ title: 'C', done: false })
    tracked = resetTracking(tracked)

    const rows = await tracked.from(schema.todos).limit(2).all()
    expect(rows).toHaveLength(2)
  })

  test('first returns single row or null', async () => {
    const empty = await tracked.from(schema.todos).first()
    expect(empty).toBeNull()

    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    tracked = resetTracking(tracked)

    const row = await tracked.from(schema.todos).first()
    expect(row).not.toBeNull()
    expect(row!.title).toBe('A')
  })

  test('first never widens a caller limit of zero', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    tracked = resetTracking(tracked)

    expect(await tracked.from(schema.todos).limit(0).all()).toEqual([])
    expect(await tracked.from(schema.todos).limit(0).first()).toBeNull()
  })

  test('update records tablesWritten', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    tracked = resetTracking(tracked)

    const updated = await tracked.from(schema.todos).where(eq('title', 'A')).update({ done: true })

    expect(tracked.tablesWritten.has('todos')).toBe(true)
    expect(updated).toHaveLength(1)
    expect(updated[0].done).toBe(true)
  })

  test('delete records tablesWritten', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    tracked = resetTracking(tracked)

    const deleted = await tracked.from(schema.todos).where(eq('title', 'A')).delete()

    expect(tracked.tablesWritten.has('todos')).toBe(true)
    expect(deleted).toHaveLength(1)
  })

  test('resetTracking clears sets', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    expect(tracked.tablesWritten.size).toBe(1)

    tracked = resetTracking(tracked)
    expect(tracked.tablesWritten.size).toBe(0)
    expect(tracked.tablesRead.size).toBe(0)
  })

  test('orderBy sorts results', async () => {
    await tracked.into(schema.todos).insert({ title: 'B', done: false })
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    await tracked.into(schema.todos).insert({ title: 'C', done: false })
    tracked = resetTracking(tracked)

    const asc = await tracked.from(schema.todos).orderBy('title').all()
    expect(asc[0].title).toBe('A')
    expect(asc[2].title).toBe('C')

    tracked = resetTracking(tracked)
    const descRows = await tracked.from(schema.todos).orderBy('title', 'desc').all()
    expect(descRows[0].title).toBe('C')
    expect(descRows[2].title).toBe('A')
  })
})

describe('DrizzleTracker.transaction', () => {
  test('commit flushes write Tags from every table touched in the batch', async () => {
    await tracked.transaction(async (tx) => {
      await tx.into(schema.todos).insert({ title: 'A', done: false })
      await tx.into(schema.tags).insert({ label: 'urgent' })
    })

    // The whole batch's write Tags reach the call-scope set as one flush.
    expect(tracked.tablesWritten.has('todos')).toBe(true)
    expect(tracked.tablesWritten.has('tags')).toBe(true)
  })

  test('commit persists every write atomically', async () => {
    await tracked.transaction(async (tx) => {
      await tx.into(schema.todos).insert({ title: 'A', done: false })
      await tx.into(schema.tags).insert({ label: 'urgent' })
    })

    const verify = resetTracking(tracked)
    expect(await verify.from(schema.todos).all()).toHaveLength(1)
    expect(await verify.from(schema.tags).all()).toHaveLength(1)
  })

  test('returns the callback result on commit', async () => {
    const id = await tracked.transaction(async (tx) => {
      const [row] = await tx.into(schema.todos).insert({ title: 'A', done: false })
      return row.id as number
    })
    expect(id).toBeGreaterThan(0)
  })

  test('rollback on throw flushes no write Tags (preview emits nothing)', async () => {
    await expect(
      tracked.transaction(async (tx) => {
        await tx.into(schema.todos).insert({ title: 'A', done: false })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // The inner write happened against the tx handle, but the rollback skips
    // the merge — the call-scope set stays empty, so no Invalidation fires.
    expect(tracked.tablesWritten.has('todos')).toBe(false)
    expect(tracked.tablesWritten.size).toBe(0)
  })

  test('rollback on throw persists nothing (atomicity)', async () => {
    await tracked.into(schema.todos).insert({ title: 'committed', done: false })
    tracked = resetTracking(tracked)

    await expect(
      tracked.transaction(async (tx) => {
        await tx.into(schema.todos).insert({ title: 'rolled-back', done: false })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const verify = resetTracking(tracked)
    const rows = await verify.from(schema.todos).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('committed')
  })

  test('explicit tx.raw.rollback() emits nothing and persists nothing', async () => {
    await expect(
      tracked.transaction(async (tx) => {
        await tx.into(schema.todos).insert({ title: 'A', done: false })
        // Must be awaited: Drizzle's rollback() returns a rejected promise (it
        // does not throw synchronously). Unawaited, the callback resolves with
        // undefined and the driver proceeds to COMMIT — the assertions below
        // would then pass only by a PGlite microtask-ordering accident and
        // break on a real async driver (postgres.js / node-postgres).
        await tx.raw.rollback()
      }),
    ).rejects.toThrow()

    expect(tracked.tablesWritten.size).toBe(0)
    const verify = resetTracking(tracked)
    expect(await verify.from(schema.todos).all()).toHaveLength(0)
  })

  test('commit-time failure rolls back: no Tags flushed, nothing persisted', async () => {
    // The inserts succeed, but the deferred unique constraint fires at COMMIT.
    // This is the load-bearing path: the merge sits after the await, so a
    // commit-time rejection must skip it exactly like a callback throw does.
    await expect(
      tracked.transaction(async (tx) => {
        await tx.into(schema.todos).insert({ title: 'A', done: false })
        await tx.raw.execute(`INSERT INTO deferred_tags (label) VALUES ('dup')`)
        await tx.raw.execute(`INSERT INTO deferred_tags (label) VALUES ('dup')`)
      }),
    ).rejects.toThrow()

    expect(tracked.tablesWritten.size).toBe(0)
    const verify = resetTracking(tracked)
    expect(await verify.from(schema.todos).all()).toHaveLength(0)
    const deferred = await verify.raw.execute('SELECT * FROM deferred_tags')
    expect(deferred.rows).toHaveLength(0)
  })

  test('nested transactions flatten Tags to the outermost call set', async () => {
    await tracked.transaction(async (tx) => {
      await tx.into(schema.todos).insert({ title: 'outer', done: false })
      await tx.transaction(async (inner) => {
        await inner.into(schema.tags).insert({ label: 'inner' })
      })
    })

    // Both levels' writes surface on the single outermost tracker.
    expect(tracked.tablesWritten.has('todos')).toBe(true)
    expect(tracked.tablesWritten.has('tags')).toBe(true)
  })
})

/**
 * A table whose SQL column names differ from its JS property keys — the shape a
 * migration-managed consumer already has. Projection names JS keys and must
 * lower to the SQL names, so this table is what proves the two vocabularies are
 * kept distinct rather than accidentally coinciding (as they do under
 * `defineSchema`, where every SQL name equals its JS key).
 */
const snakeTodos = pgTable('snake_todos', {
  id: integer('id').primaryKey(),
  todoTitle: pgText('todo_title').notNull(),
  ownerName: pgText('owner_name').notNull(),
})

/** The migration-managed relation used by every draftable table in this file. */
const createDraftStorage = () =>
  tracked.raw.execute(`
    ${draftChangesTableDdl}
  `)

/** Create the migration-managed snake-case fixture and optional draft storage. */
const createSnakeTodos = async ({ withDraftStorage = false } = {}) => {
  await tracked.raw.execute(`
    CREATE TABLE IF NOT EXISTS snake_todos (
      id INTEGER PRIMARY KEY,
      todo_title TEXT NOT NULL,
      owner_name TEXT NOT NULL
    )
  `)
  if (withDraftStorage) await createDraftStorage()
}

describe('SelectBuilder projection', () => {
  test('select() narrows the returned columns', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    const rows = await tracked.from(schema.todos).select('title').all()

    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0]).sort()).toEqual(['title'])
    expect(rows[0].title).toBe('A')
  })

  test('select() accepts multiple columns and keeps the named order', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: true })
    const rows = await tracked.from(schema.todos).select('id', 'done').all()

    expect(Object.keys(rows[0])).toEqual(['id', 'done'])
    expect(rows[0].done).toBe(true)
  })

  test('a projected read still tags the whole TABLE, not the columns', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    tracked = resetTracking(tracked)

    await tracked.from(schema.todos).select('id').all()

    // The invalidation model is read∩write over table names. A projected read
    // must still invalidate when a NON-projected column is written, so the tag
    // stays the table — narrowing it to columns would be a different model.
    expect(tracked.tablesRead.has('todos')).toBe(true)
  })

  test('projection composes with where, orderBy and limit', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    await tracked.into(schema.todos).insert({ title: 'B', done: true })
    await tracked.into(schema.todos).insert({ title: 'C', done: true })

    const rows = await tracked
      .from(schema.todos)
      .select('title')
      .where(eq('done', true))
      .orderBy('title', 'desc')
      .limit(1)
      .all()

    expect(rows).toEqual([{ title: 'C' }])
  })

  test('first() returns a projected row', async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    const row = await tracked.from(schema.todos).select('title').first()

    expect(row).toEqual({ title: 'A' })
  })

  test('first() on a projected read with no match returns null', async () => {
    const row = await tracked.from(schema.todos).select('title').where(eq('id', 999)).first()
    expect(row).toBeNull()
  })

  test('an unknown projected column throws rather than dropping the field', async () => {
    expect(() =>
      // oxlint-disable-next-line typescript/no-explicit-any -- deliberately bypassing the key constraint to reach the runtime guard
      (tracked.from(schema.todos) as any).select('nope').toSql(),
    ).toThrow('Unknown column: nope')
  })

  test('select() with no columns throws', () => {
    // oxlint-disable-next-line typescript/no-explicit-any -- the tuple type forbids this at compile time; this is the untyped-caller path
    expect(() => (tracked.from(schema.todos) as any).select()).toThrow(
      'select() requires at least one column',
    )
  })

  test('projection names JS keys and lowers to the column SQL names', async () => {
    await createSnakeTodos()
    await tracked.into(snakeTodos).insert({ id: 1, todoTitle: 'A', ownerName: 'yh' })
    tracked = resetTracking(tracked)

    const rows = await tracked.from(snakeTodos).select('todoTitle').all()

    expect(rows).toEqual([{ todoTitle: 'A' }])
    // The tag is the SQL table name, so it matches a raw write's manual tag.
    expect(tracked.tablesRead.has('snake_todos')).toBe(true)
  })

  test('a draft read projects the coalesce, matching the canonical builder', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'base', done: false })
    await tracked.withDraft('d1').from(schema.todos).where(eq('id', 1)).update({
      title: 'overridden',
    })

    const rows = await tracked.withDraft('d1').from(schema.todos).select('title').all()

    // Projected to `title` alone, and still coalesced (draft wins over base).
    expect(rows).toEqual([{ title: 'overridden' }])
  })

  test('a draft projection omitting the PK still joins, orders and suppresses tombstones', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'kept', done: false })
    await tracked.into(schema.todos).insert({ title: 'deleted', done: false })
    await tracked.withDraft('d1').from(schema.todos).where(eq('id', 2)).delete()

    const rows = await tracked.withDraft('d1').from(schema.todos).select('title').all()

    // The ORDER BY and tombstone WHERE name the PK directly, so dropping it from
    // the SELECT list changes the output shape only.
    expect(rows).toEqual([{ title: 'kept' }])
  })

  test('an unknown column in a draft projection throws', async () => {
    await expect(
      // oxlint-disable-next-line typescript/no-explicit-any -- reaching the runtime guard past the key constraint
      (tracked.withDraft('d1').from(schema.todos) as any).select('nope').all(),
    ).rejects.toThrow('Unknown column: nope')
  })

  /** Selecting one public property returns only that property on the canonical path. */
  test('a canonical projection returns only the selected values', async () => {
    await tracked.into(schema.todos).insert({ title: 'projected', done: true })

    const projected = await tracked.from(schema.todos).select('title').all()
    const fullRows = await tracked.from(schema.todos).all()

    expect(projected).toEqual([{ title: 'projected' }])
    expect(Object.keys(projected[0] ?? {})).toEqual(['title'])
    expect(fullRows).toEqual([{ id: 1, title: 'projected', done: true }])
  })
})

describe('DraftSelectBuilder orderBy / limit', () => {
  test('orders by the COALESCED value, so a draft override moves the row', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'aaa', done: false })
    await tracked.into(schema.todos).insert({ title: 'bbb', done: false })
    // Row 1 is renamed to sort LAST. Ordering on `b."title"` would still see
    // 'aaa' and put it first — this is the assertion that pins COALESCE.
    await tracked.withDraft('d1').from(schema.todos).where(eq('id', 1)).update({ title: 'zzz' })

    const rows = await tracked.withDraft('d1').from(schema.todos).orderBy('title').all()

    expect(rows.map((r) => r.title)).toEqual(['bbb', 'zzz'])
  })

  test('a draft-INSERTED row sorts by its draft value, not as NULL', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'mmm', done: false })
    // No base row for id 99 — `b."title"` is NULL on this side of the FULL OUTER
    // JOIN, so only the coalesced expression can place it correctly.
    await tracked.withDraft('d1').into(schema.todos).insert({
      id: 99,
      title: 'aaa',
      done: false,
    })

    const rows = await tracked.withDraft('d1').from(schema.todos).orderBy('title').all()

    expect(rows.map((r) => r.title)).toEqual(['aaa', 'mmm'])
  })

  test('desc reverses the order', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'aaa', done: false })
    await tracked.into(schema.todos).insert({ title: 'bbb', done: false })

    const rows = await tracked.withDraft('d1').from(schema.todos).orderBy('title', 'desc').all()

    expect(rows.map((r) => r.title)).toEqual(['bbb', 'aaa'])
  })

  test('limit caps the coalesced set, and composes with orderBy as top-N', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'ccc', done: false })
    await tracked.into(schema.todos).insert({ title: 'aaa', done: false })
    await tracked.into(schema.todos).insert({ title: 'bbb', done: false })

    const capped = await tracked.withDraft('d1').from(schema.todos).limit(2).all()
    expect(capped).toHaveLength(2)

    const topOne = await tracked.withDraft('d1').from(schema.todos).orderBy('title').limit(1).all()
    expect(topOne.map((r) => r.title)).toEqual(['aaa'])
  })

  test('a tombstoned row does not consume a limit slot', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'first', done: false })
    await tracked.into(schema.todos).insert({ title: 'second', done: false })
    await tracked.withDraft('d1').from(schema.todos).where(eq('id', 1)).delete()

    // LIMIT applies after the tombstone WHERE. If the order were reversed, the
    // suppressed row would eat the only slot and this would come back empty.
    const rows = await tracked.withDraft('d1').from(schema.todos).limit(1).all()

    expect(rows.map((r) => r.title)).toEqual(['second'])
  })

  test('ties on the ordering column stay deterministic via the PK tiebreaker', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'same', done: false })
    await tracked.into(schema.todos).insert({ title: 'same', done: false })
    await tracked.into(schema.todos).insert({ title: 'same', done: false })

    const ids = async () =>
      (await tracked.withDraft('d1').from(schema.todos).orderBy('title').all()).map((r) => r.id)

    expect(await ids()).toEqual([1, 2, 3])
    expect(await ids()).toEqual(await ids())
  })

  test('first() returns one row and no longer fetches the whole set', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'aaa', done: false })
    await tracked.into(schema.todos).insert({ title: 'bbb', done: false })

    const row = await tracked.withDraft('d1').from(schema.todos).first()

    expect(row?.title).toBe('aaa')
  })

  test('an unknown orderBy column throws instead of falling back to PK order', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'aaa', done: false })

    await expect(tracked.withDraft('d1').from(schema.todos).orderBy('nope').all()).rejects.toThrow(
      'Unknown column: nope',
    )
  })

  test('orderBy lowers the JS property key to its SQL column name', async () => {
    await createSnakeTodos({ withDraftStorage: true })
    await tracked.raw.execute(
      `INSERT INTO snake_todos (id, todo_title, owner_name) VALUES (1, 'bbb', 'x'), (2, 'aaa', 'y')`,
    )

    // `todoTitle` is the property key; the emitted SQL must say "todo_title".
    const rows = await tracked.withDraft('d1').from(snakeTodos).orderBy('todoTitle').all()

    expect(rows.map((r) => r.todoTitle)).toEqual(['aaa', 'bbb'])
  })
})

describe('read clauses are rejected on write terminals', () => {
  beforeEach(async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    await tracked.into(schema.todos).insert({ title: 'B', done: false })
    await tracked.into(schema.todos).insert({ title: 'C', done: false })
    tracked = resetTracking(tracked)
  })

  test('limit before delete throws instead of deleting every match', async () => {
    await expect(
      tracked.from(schema.todos).where(eq('done', false)).limit(1).delete(),
    ).rejects.toThrow('limit() cannot precede delete()')

    // The regression this guard exists for: before it, all three were deleted.
    expect(await resetTracking(tracked).from(schema.todos).all()).toHaveLength(3)
  })

  test('the write is not tagged when the guard rejects it', async () => {
    await expect(tracked.from(schema.todos).limit(1).delete()).rejects.toThrow()

    // The guard runs BEFORE `tablesWritten.add`, so a rejected write cannot
    // invalidate subscriptions for a mutation that never happened.
    expect(tracked.tablesWritten.has('todos')).toBe(false)
    expect(tracked.tablesWritten.size).toBe(0)
  })

  test('orderBy before update throws', async () => {
    await expect(
      tracked.from(schema.todos).orderBy('title').update({ done: true }),
    ).rejects.toThrow('orderBy() cannot precede update()')
  })

  test('select before update throws', async () => {
    await expect(tracked.from(schema.todos).select('id').update({ done: true })).rejects.toThrow(
      'select() cannot precede update()',
    )
  })

  test('several attached clauses are all named in one error', async () => {
    await expect(
      tracked.from(schema.todos).select('id').orderBy('title').limit(1).delete(),
    ).rejects.toThrow('select() / orderBy() / limit() cannot precede delete()')
  })

  test('the message points at the correct alternative', async () => {
    await expect(tracked.from(schema.todos).limit(1).delete()).rejects.toThrow(
      /pin them with where\(\).*read it first .*then delete by primary key/s,
    )
  })

  test('a plain where-scoped write is unaffected', async () => {
    const updated = await tracked.from(schema.todos).where(eq('title', 'A')).update({ done: true })
    expect(updated).toHaveLength(1)

    const deleted = await tracked.from(schema.todos).where(eq('title', 'B')).delete()
    expect(deleted).toHaveLength(1)
  })

  test('an unlimited bulk delete is still allowed — it says what it does', async () => {
    const deleted = await tracked.from(schema.todos).where(eq('done', false)).delete()
    expect(deleted).toHaveLength(3)
  })

  test('the draft write path rejects the same clauses', async () => {
    await createDraftStorage()
    const draft = () => tracked.withDraft('d1').from(schema.todos)

    await expect(draft().select('title').where(eq('id', 1)).update({ done: true })).rejects.toThrow(
      'select() cannot precede update()',
    )
    await expect(draft().limit(1).where(eq('id', 1)).delete()).rejects.toThrow(
      'limit() cannot precede delete()',
    )
    await expect(
      draft().orderBy('title').where(eq('id', 1)).update({ done: true }),
    ).rejects.toThrow('orderBy() cannot precede update()')
  })

  test('a draft write with no read clauses still lands in derived storage', async () => {
    await createDraftStorage()

    await tracked.withDraft('d1').from(schema.todos).where(eq('id', 1)).update({ done: true })

    const rows = await tracked.withDraft('d1').from(schema.todos).where(eq('id', 1)).all()
    expect(rows[0]?.done).toBe(true)
  })

  test('first() then a write on the SAME builder is not rejected', async () => {
    // Regression: `first()` used to assign `_limitVal`, which the guard reads to
    // decide whether the CALLER attached `limit()`. A reused builder was then
    // rejected for a clause it never attached. `first()` now lowers its LIMIT 1
    // as an override instead.
    const b = tracked.from(schema.todos).where(eq('title', 'A'))

    const row = await b.first()
    expect(row?.title).toBe('A')

    const updated = await b.update({ done: true })
    expect(updated).toHaveLength(1)
  })

  test('a caller-attached limit is still rejected after a read on the same builder', async () => {
    // The other half: the override must not mask a real `limit()`.
    const b = tracked.from(schema.todos).limit(1)
    expect(await b.all()).toHaveLength(1)
    await expect(b.delete()).rejects.toThrow('limit() cannot precede delete()')
  })

  test('draft first() then a write on the same builder is not rejected either', async () => {
    await createDraftStorage()
    const b = tracked.withDraft('d1').from(schema.todos).where(eq('id', 1))

    expect((await b.first())?.id).toBe(1)
    await b.update({ done: true })

    const rows = await tracked.withDraft('d1').from(schema.todos).where(eq('id', 1)).all()
    expect(rows[0]?.done).toBe(true)
  })

  test('the prescribed two-step alternative works, in a draft too', async () => {
    await createDraftStorage()
    const handle = tracked.withDraft('d1')

    // This is what the error message tells a caller to write.
    const oldest = await handle.from(schema.todos).orderBy('title').limit(1).first()
    expect(oldest?.title).toBe('A')
    await handle
      .from(schema.todos)
      .where(eq('id', oldest!.id as number))
      .delete()

    const remaining = await handle.from(schema.todos).all()
    expect(remaining.map((r) => r.title)).toEqual(['B', 'C'])
  })
})

/**
 * The builder is a VALUE: every clause returns a new instance and no clause
 * assigns to the receiver.
 *
 * Three separately-reported bugs were one defect — a mutable builder returning
 * `this` handed out two names for one query — so these tests pin the property
 * rather than the three symptoms. If a future clause is added with
 * `this._x = …; return this`, one of them fails.
 */
describe('clause methods return a copy, not the receiver', () => {
  beforeEach(async () => {
    await tracked.into(schema.todos).insert({ title: 'A', done: false })
    await tracked.into(schema.todos).insert({ title: 'B', done: true })
    tracked = resetTracking(tracked)
  })

  test('select() does not change what the original builder yields', async () => {
    const base = tracked.from(schema.todos)
    const projected = base.select('title')

    expect(projected).not.toBe(base)
    // Before: `select()` mutated `base` and returned it re-typed, so the object
    // and its type disagreed and BOTH names yielded `{title}`.
    expect(Object.keys((await projected.all())[0])).toEqual(['title'])
    expect(Object.keys((await base.all())[0]).sort()).toEqual(['done', 'id', 'title'])
  })

  test('where() accumulates on the copy only', async () => {
    const base = tracked.from(schema.todos)
    const filtered = base.where(eq('done', true))

    expect(await filtered.all()).toHaveLength(1)
    expect(await base.all()).toHaveLength(2)
  })

  test('two branches off one builder do not see each other', async () => {
    const base = tracked.from(schema.todos)
    const asc = base.orderBy('title')
    const desc = base.orderBy('title', 'desc')

    expect((await asc.all()).map((r) => r.title)).toEqual(['A', 'B'])
    expect((await desc.all()).map((r) => r.title)).toEqual(['B', 'A'])
  })

  test('a read clause never reaches a write terminal built from the same base', async () => {
    const base = tracked.from(schema.todos).where(eq('title', 'A'))
    // The read branch is a different object, so consuming it leaves nothing
    // attached to `base` for the guard to reject.
    expect(await base.orderBy('title').limit(1).all()).toHaveLength(1)

    expect(await base.update({ done: true })).toHaveLength(1)
  })

  test('the draft builder copies too — same property, same reasons', async () => {
    await createDraftStorage()
    const base = tracked.withDraft('d1').from(schema.todos)
    const limited = base.limit(1)

    expect(limited).not.toBe(base)
    expect(await limited.all()).toHaveLength(1)
    expect(await base.all()).toHaveLength(2)
  })

  test('a draft read branch does not block a write off the same base', async () => {
    await createDraftStorage()
    const base = tracked.withDraft('d1').from(schema.todos).where(eq('id', 1))

    expect(await base.orderBy('title').all()).toHaveLength(1)
    await base.update({ done: true })

    const rows = await tracked.withDraft('d1').from(schema.todos).where(eq('id', 1)).all()
    expect(rows[0]?.done).toBe(true)
  })
})

describe('clause column resolution is total', () => {
  test('a projection naming an Object.prototype key throws', () => {
    // `columns['constructor']` resolves up the prototype chain, so a truthiness
    // check accepted it and lowered `select  from "todos"` — which Postgres
    // ACCEPTS, returning fieldless rows. Own-property check, not truthiness.
    for (const key of ['constructor', 'hasOwnProperty', 'toString']) {
      expect(() =>
        // oxlint-disable-next-line typescript/no-explicit-any -- reaching the runtime guard past the key constraint
        (tracked.from(schema.todos) as any).select(key).toSql(),
      ).toThrow(`Unknown column: ${key}`)
    }
  })

  test('an orderBy naming an Object.prototype key throws', () => {
    expect(() => tracked.from(schema.todos).orderBy('constructor').toSql()).toThrow(
      'Unknown column: constructor',
    )
  })

  test('orderBy("") is rejected at the call, not silently unordered', () => {
    // The lowering used to gate on truthiness while the write guard tested
    // `!== undefined`: an empty name produced an unordered read the caller
    // believed was sorted, AND still blocked a later write.
    expect(() => tracked.from(schema.todos).orderBy('')).toThrow('orderBy() requires a column name')
    expect(() => tracked.withDraft('d1').from(schema.todos).orderBy('')).toThrow(
      'orderBy() requires a column name',
    )
  })

  test('a draft orderBy naming an unknown column throws', async () => {
    await createDraftStorage()
    await expect(tracked.withDraft('d1').from(schema.todos).orderBy('nope').all()).rejects.toThrow(
      'Unknown column: nope',
    )
  })
})

describe('canonical and draft reads agree on tied rows', () => {
  /** Equal sort values produce the same primary-key order on canonical and draft reads. */
  test('canonical and draft deterministically break ties by primary key', async () => {
    await createDraftStorage()
    // Deliberately oppose heap order and primary-key order. This would expose a
    // missing tiebreaker without asserting how the query is lowered to SQL.
    await tracked.into(schema.todos).insert({ id: 30, title: 'thirty', done: true })
    await tracked.into(schema.todos).insert({ id: 10, title: 'ten', done: true })
    await tracked.into(schema.todos).insert({ id: 20, title: 'twenty', done: true })

    for (const direction of ['asc', 'desc'] as const) {
      const canonical = await tracked.from(schema.todos).orderBy('done', direction).all()
      const draft = await tracked
        .withDraft('d1')
        .from(schema.todos)
        .orderBy('done', direction)
        .all()

      expect(canonical.map((row) => row.id)).toEqual([10, 20, 30])
      expect(draft).toEqual(canonical)
    }
  })

  /** When the primary key is the requested sort column, descending order is not overwritten by a tiebreaker. */
  test('ordering by the primary key respects the requested direction', async () => {
    await tracked.into(schema.todos).insert({ id: 30, title: 'thirty', done: true })
    await tracked.into(schema.todos).insert({ id: 10, title: 'ten', done: true })
    await tracked.into(schema.todos).insert({ id: 20, title: 'twenty', done: true })

    const ascending = await tracked.from(schema.todos).orderBy('id').all()
    const descending = await tracked.from(schema.todos).orderBy('id', 'desc').all()

    expect(ascending.map((row) => row.id)).toEqual([10, 20, 30])
    expect(descending.map((row) => row.id)).toEqual([30, 20, 10])
  })

  test('limit(1) over a tie picks the same row on both paths', async () => {
    await createDraftStorage()
    await tracked.into(schema.todos).insert({ title: 'x', done: true })
    await tracked.into(schema.todos).insert({ title: 'y', done: true })

    const canonical = await tracked.from(schema.todos).orderBy('done', 'desc').limit(1).first()
    const draft = await tracked
      .withDraft('d1')
      .from(schema.todos)
      .orderBy('done', 'desc')
      .limit(1)
      .first()

    // Without the tiebreaker this is heap order on one side and PK order on the
    // other — and a handler cannot tell which handle it holds.
    expect(canonical?.id).toBe(draft?.id)
  })

  test('the tiebreaker does not displace the named column', async () => {
    // Ordering must still be BY the named column; the PK only breaks ties.
    await tracked.into(schema.todos).insert({ title: 'b', done: false })
    await tracked.into(schema.todos).insert({ title: 'a', done: false })

    const rows = await tracked.from(schema.todos).orderBy('title').all()
    expect(rows.map((r) => r.title)).toEqual(['a', 'b'])
    expect(rows.map((r) => r.id)).toEqual([2, 1])
  })
})

describe('draft writes to array columns', () => {
  const arraySchema = defineSchema({
    notes: table({
      id: int.primaryKey(),
      tags: text.array(),
    }).draftable(),
  })

  beforeEach(async () => {
    await db.execute(
      `CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, tags TEXT[] NOT NULL)`,
    )
    await createDraftStorage()
  })

  /**
   * Drizzle encodes an array column as one PostgreSQL literal string. The draft
   * read lowering rebuilds the column from a JSON array instead, so a proposed
   * array has to be stored element by element or the draft can never be read.
   */
  test('an array proposed in a draft reads back as the array', async () => {
    await tracked.into(arraySchema.notes).insert({ tags: ['a'] })

    const draft = tracked.withDraft('d1').from(arraySchema.notes)
    await draft.where(eq('id', 1)).update({ tags: ['b', 'c'] })
    await tracked
      .withDraft('d1')
      .into(arraySchema.notes)
      .insert({ id: 2, tags: ['x'] })

    const rows = await tracked.withDraft('d1').from(arraySchema.notes).orderBy('id').all()
    expect(rows.map((row) => row.tags)).toEqual([['b', 'c'], ['x']])
    const canonical = await tracked.from(arraySchema.notes).all()
    expect(canonical.map((row) => row.tags)).toEqual([['a']])
  })
})
