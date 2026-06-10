import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema } from '../schema'
import { text, int, boolean } from '../dsl'
import { eq } from '../operators'
import { createTrackedDb, resetTracking } from '../tracked-db'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
  tags: {
    id: int.primaryKey(),
    label: text,
  },
})

let pg: PGlite
let db: ReturnType<typeof drizzle>
let tracked: ReturnType<typeof createTrackedDb>

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

  tracked = createTrackedDb(db)
})

describe('TrackedDb', () => {
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

describe('TrackedDb.transaction', () => {
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
