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
  await db.execute('DELETE FROM todos')

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
