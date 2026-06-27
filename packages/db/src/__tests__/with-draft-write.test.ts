/**
 * Tests for the `withDraft(draftId)` WRITE path (YW-121).
 *
 * YW-120 added the READ coalesce (`from(table).all()`). This adds the write side:
 *   - `into(table).insert(row)`             → sparse upsert into `<table>__draft`
 *   - `from(table).where(eqPk).update(vals)` → sparse cell edit in the shadow
 *   - `from(table).where(eqPk).delete()`     → tombstone row in the shadow
 *
 * The load-bearing contracts:
 *   - a draft write lands in `<table>__draft`, NOT the canonical table
 *   - update is SPARSE (one field's edit does not clobber another)
 *   - delete TOMBSTONES (the coalesce read then suppresses the row)
 *   - no-draft (canonical) reads + writes are unaffected
 *   - draftId is a BOUND parameter (no injection)
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { pgTable, integer, text as pgText, boolean as pgBoolean } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createDrizzleTracker } from '../drizzle-tracker'
import { eq } from '../operators'

const todos = pgTable('todos', {
  id: integer('id').primaryKey(),
  title: pgText('title').notNull(),
  done: pgBoolean('done').notNull(),
})

let pg: PGlite
let db: ReturnType<typeof drizzle>
let tracked: ReturnType<typeof createDrizzleTracker>

beforeEach(async () => {
  pg = new PGlite()
  db = drizzle(pg)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos__draft (
      draft_id TEXT NOT NULL,
      id INTEGER NOT NULL,
      title TEXT,
      done BOOLEAN,
      __tombstone BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (draft_id, id)
    )
  `)
  // Canonical seed: {1,apple,false}, {2,banana,false}, {3,cherry,false}
  await db.execute(`
    INSERT INTO todos (id, title, done) VALUES
      (1,'apple',false),(2,'banana',false),(3,'cherry',false)
  `)
  tracked = createDrizzleTracker(db)
})

async function shadowRows(draftId: string) {
  // Bound parameter (sql tag) — never string-interpolate a draftId, even in a
  // test helper (the injection test feeds a DROP TABLE payload through here).
  const res = await db.execute(
    sql`SELECT * FROM todos__draft WHERE draft_id = ${draftId} ORDER BY id`,
  )
  // PGlite returns { rows }
  // oxlint-disable-next-line typescript/no-explicit-any
  return (res as any).rows as Record<string, unknown>[]
}

describe('withDraft write — into().insert()', () => {
  test('a draft insert lands in <table>__draft, not the canonical table', async () => {
    await tracked.withDraft('d1').into(todos).insert({ id: 4, title: 'date', done: false })

    // Canonical untouched: still 3 rows, no id=4.
    const canonical = await tracked.from(todos).all()
    expect(canonical).toHaveLength(3)
    expect(canonical.map((r: Record<string, unknown>) => (r as { id: number }).id).sort()).toEqual([
      1, 2, 3,
    ])

    // Shadow has the row, tombstone=false.
    const rows = await shadowRows('d1')
    expect(rows).toHaveLength(1)
    expect(rows[0]['id']).toBe(4)
    expect(rows[0]['title']).toBe('date')
    expect(rows[0]['__tombstone']).toBe(false)
  })

  test('the draft insert surfaces through the coalesce read', async () => {
    await tracked.withDraft('d1').into(todos).insert({ id: 4, title: 'date', done: false })
    const rows = await tracked.withDraft('d1').from(todos).all()
    const byId = Object.fromEntries(rows.map((r) => [r['id'], r]))
    expect(byId[4]).toBeDefined()
    expect(byId[4]['title']).toBe('date')
  })

  test('insert requires a client-minted PK', async () => {
    await expect(
      // @ts-expect-error — intentionally omit the PK to prove the runtime guard
      tracked.withDraft('d1').into(todos).insert({ title: 'no-id', done: false }),
    ).rejects.toThrow('missing primary key')
  })
})

describe('withDraft write — from().where(eqPk).update()', () => {
  test('a draft update edits the shadow (canonical untouched) and the coalesce read wins', async () => {
    await tracked.withDraft('d1').from(todos).where(eq('id', 1)).update({ title: 'APPLE-edited' })

    // Canonical id=1 still 'apple'.
    const canonical = await tracked.from(todos).all()
    const canonById = Object.fromEntries(
      canonical.map((r: Record<string, unknown>) => [(r as { id: number }).id, r]),
    )
    expect((canonById[1] as { title: string }).title).toBe('apple')

    // Coalesce read sees the edit.
    const draftRows = await tracked.withDraft('d1').from(todos).all()
    const draftById = Object.fromEntries(draftRows.map((r) => [r['id'], r]))
    expect(draftById[1]['title']).toBe('APPLE-edited')
  })

  test('update is SPARSE — a second edit of a different field accumulates, not clobbers', async () => {
    const handle = tracked.withDraft('d1')
    await handle.from(todos).where(eq('id', 1)).update({ title: 'APPLE-edited' })
    await handle.from(todos).where(eq('id', 1)).update({ done: true })

    const rows = await shadowRows('d1')
    expect(rows).toHaveLength(1)
    // Both edits present on the single shadow row.
    expect(rows[0]['title']).toBe('APPLE-edited')
    expect(rows[0]['done']).toBe(true)

    // Coalesce read reflects BOTH, with the untouched 'id' from canonical.
    const draftRows = await tracked.withDraft('d1').from(todos).all()
    const byId = Object.fromEntries(draftRows.map((r) => [r['id'], r]))
    expect(byId[1]['title']).toBe('APPLE-edited')
    expect(byId[1]['done']).toBe(true)
  })

  test('update without a PK-pinning where throws (PK-addressed only)', async () => {
    await expect(tracked.withDraft('d1').from(todos).update({ title: 'x' })).rejects.toThrow(
      /requires exactly one .*where/,
    )
    await expect(
      tracked.withDraft('d1').from(todos).where(eq('title', 'apple')).update({ done: true }),
    ).rejects.toThrow(/requires .*primary key|PK-addressed/)
  })
})

describe('withDraft write — from().where(eqPk).delete()', () => {
  test('a draft delete tombstones the row; the coalesce read suppresses it', async () => {
    await tracked.withDraft('d1').from(todos).where(eq('id', 2)).delete()

    // Canonical still has id=2.
    const canonical = await tracked.from(todos).all()
    expect(canonical.map((r: Record<string, unknown>) => (r as { id: number }).id).sort()).toEqual([
      1, 2, 3,
    ])

    // Shadow has a tombstone row for id=2.
    const rows = await shadowRows('d1')
    expect(rows).toHaveLength(1)
    expect(rows[0]['id']).toBe(2)
    expect(rows[0]['__tombstone']).toBe(true)

    // Coalesce read omits id=2.
    const draftRows = await tracked.withDraft('d1').from(todos).all()
    expect(draftRows.map((r) => r['id']).sort()).toEqual([1, 3])
  })

  test('delete without a PK-pinning where throws', async () => {
    await expect(tracked.withDraft('d1').from(todos).delete()).rejects.toThrow(
      /requires exactly one .*where/,
    )
  })
})

describe('withDraft write — isolation + injection safety', () => {
  test('writes for two draftIds are isolated by the (draft_id, id) key', async () => {
    await tracked.withDraft('dA').from(todos).where(eq('id', 1)).update({ title: 'A-edit' })
    await tracked.withDraft('dB').from(todos).where(eq('id', 1)).update({ title: 'B-edit' })

    const a = await tracked.withDraft('dA').from(todos).all()
    const b = await tracked.withDraft('dB').from(todos).all()
    expect((Object.fromEntries(a.map((r) => [r['id'], r]))[1] as { title: string }).title).toBe(
      'A-edit',
    )
    expect((Object.fromEntries(b.map((r) => [r['id'], r]))[1] as { title: string }).title).toBe(
      'B-edit',
    )
  })

  test('a draftId containing a single-quote is a bound parameter (no injection)', async () => {
    // Inserts under a quote-laden draftId, then reads it back — proves the value
    // round-trips as a bound param rather than breaking/escaping the SQL.
    const evil = "d'; DROP TABLE todos__draft; --"
    await tracked.withDraft(evil).into(todos).insert({ id: 9, title: 'safe', done: false })
    const rows = await tracked.withDraft(evil).from(todos).all()
    const byId = Object.fromEntries(rows.map((r) => [r['id'], r]))
    expect(byId[9]).toBeDefined()
    expect(byId[9]['title']).toBe('safe')
    // The shadow stores exactly one row under the literal evil draftId — proving
    // the write side bound it too (read back through the parameterized helper).
    const shadow = await shadowRows(evil)
    expect(shadow).toHaveLength(1)
    expect(shadow[0]['id']).toBe(9)
    // The table still exists (the DROP TABLE payload never executed) and
    // canonical is intact.
    expect(await tracked.from(todos).all()).toHaveLength(3)
  })

  test('shadow write records tablesWritten = <table>__draft (invalidates draft readers only)', async () => {
    const handle = tracked.withDraft('d1')
    await handle.into(todos).insert({ id: 5, title: 'e', done: false })
    expect(handle.tablesWritten.has('todos__draft')).toBe(true)
    expect(handle.tablesWritten.has('todos')).toBe(false)
  })
})

describe('withDraft write — read-path guard preserved', () => {
  test('.where(eq(pk)).all() now returns the PK-pinned coalesced row (read path)', async () => {
    // A single PK eq is a valid READ predicate (the handler shape). Here no
    // draft delta exists for id=1, so the canonical row is returned, scoped to
    // that one PK. Non-PK / multi-filter reads still throw (covered elsewhere).
    const rows = await tracked.withDraft('d1').from(todos).where(eq('id', 1)).all()
    expect(rows).toHaveLength(1)
    expect((rows[0] as { id: number; title: string }).id).toBe(1)
    expect((rows[0] as { title: string }).title).toBe('apple')
  })

  test('.orderBy()/.limit() still throw on a draft read builder', () => {
    expect(() => tracked.withDraft('d1').from(todos).orderBy('id')).toThrow('not yet implemented')
    expect(() => tracked.withDraft('d1').from(todos).limit(5)).toThrow('not yet implemented')
  })

  test('draft handle.transaction() throws a named contract error (publish owns atomicity)', () => {
    expect(() => tracked.withDraft('d1').transaction(async () => 1)).toThrow(
      /cannot open its own transaction/,
    )
  })

  test('draft from().first() returns the first coalesced row (unmodified handlers can call it)', async () => {
    // A draft insert of id=4 + canonical 1,2,3 → first() returns id=1 (pk order).
    await tracked.withDraft('d1').into(todos).insert({ id: 4, title: 'date', done: false })
    const row = await tracked.withDraft('d1').from(todos).first()
    expect(row).not.toBeNull()
    expect((row as { id: number }).id).toBe(1)
  })
})
