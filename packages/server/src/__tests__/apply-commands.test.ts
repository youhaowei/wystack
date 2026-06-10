import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean, eq } from '@wystack/db'
import { createWyStack } from '../create'
import { query, mutation } from '../functions'
import { applyCommands } from '../apply-commands'

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

let app: Awaited<ReturnType<typeof createWyStack>>

beforeEach(async () => {
  const pg = new PGlite()
  const db = drizzle(pg)
  // `id` is a plain INT (client-minted), not SERIAL — the client-generated-id
  // invariant requires the batch to choose ids, and a later command to reference
  // an id an earlier command inserted.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL
    )
  `)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL
    )
  `)

  app = await createWyStack({
    db,
    functions: {
      listTodos: query({
        args: {},
        handler: async (ctx) => ctx.db.from(schema.todos).all(),
      }),
      listTags: query({
        args: {},
        handler: async (ctx) => ctx.db.from(schema.tags).all(),
      }),
      addTodo: mutation({
        args: { id: int, title: text },
        handler: async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ id: args.id, title: args.title, done: false }),
      }),
      addTag: mutation({
        args: { id: int, label: text },
        handler: async (ctx, args) =>
          ctx.db.into(schema.tags).insert({ id: args.id, label: args.label }),
      }),
      // Marks a todo done — used to prove a later command can read/write an
      // entity an earlier command in the same batch created.
      markDone: mutation({
        args: { id: int },
        handler: async (ctx, args) =>
          ctx.db.from(schema.todos).where(eq('id', args.id)).update({ done: true }),
      }),
      // Always throws — used to prove mid-batch failure rolls the whole batch back.
      boom: mutation({
        args: {},
        handler: async () => {
          throw new Error('command boom')
        },
      }),
    },
  })
})

describe('applyCommands — commit mode', () => {
  test('applies all commands atomically and persists them', async () => {
    const result = await applyCommands(
      app,
      [
        { path: 'addTodo', args: { id: 1, title: 'A' } },
        { path: 'addTag', args: { id: 1, label: 'urgent' } },
      ],
      { mode: 'commit' },
    )

    expect(result.mode).toBe('commit')
    expect(result.commandCount).toBe(2)

    const { result: todos } = await app.call('listTodos', {})
    const { result: tags } = await app.call('listTags', {})
    expect(todos as unknown[]).toHaveLength(1)
    expect(tags as unknown[]).toHaveLength(1)
  })

  test('surfaces the union of tablesWritten across the batch (one invalidation)', async () => {
    const result = await applyCommands(
      app,
      [
        { path: 'addTodo', args: { id: 1, title: 'A' } },
        { path: 'addTag', args: { id: 1, label: 'urgent' } },
      ],
      { mode: 'commit' },
    )

    // Both tables in one merged set — the caller flushes this once to invalidation.
    expect(result.tablesWritten.has('todos')).toBe(true)
    expect(result.tablesWritten.has('tags')).toBe(true)
    expect(result.tablesWritten.size).toBe(2)
  })

  test('a mid-batch failure rolls back ALL commands, including those before it', async () => {
    await expect(
      applyCommands(
        app,
        [
          { path: 'addTodo', args: { id: 1, title: 'before-failure' } },
          { path: 'boom', args: {} },
          { path: 'addTodo', args: { id: 2, title: 'after-failure' } },
        ],
        { mode: 'commit' },
      ),
    ).rejects.toThrow('command boom')

    // The command BEFORE the failure must not persist — all-or-nothing.
    const { result: todos } = await app.call('listTodos', {})
    expect(todos as unknown[]).toHaveLength(0)
  })

  test('a later command can reference an entity an earlier command created (client-id invariant)', async () => {
    const result = await applyCommands(
      app,
      [
        { path: 'addTodo', args: { id: 42, title: 'A' } },
        { path: 'markDone', args: { id: 42 } },
      ],
      { mode: 'commit' },
    )

    expect(result.commandCount).toBe(2)
    const { result: todos } = await app.call('listTodos', {})
    const rows = todos as { id: number; done: boolean }[]
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(42)
    // markDone saw the row addTodo inserted in the SAME transaction.
    expect(rows[0].done).toBe(true)
  })

  test('surfaces each command handler return value, index-correlated to the batch', async () => {
    const result = await applyCommands(
      app,
      [
        { path: 'addTodo', args: { id: 1, title: 'A' } },
        { path: 'addTag', args: { id: 1, label: 'urgent' } },
      ],
      { mode: 'commit' },
    )

    // results[i] is commands[i]'s handler return — same value app.call surfaces.
    expect(result.results).toHaveLength(2)
    const [todoRows, tagRows] = result.results as { title?: string; label?: string }[][]
    expect(todoRows[0].title).toBe('A')
    expect(tagRows[0].label).toBe('urgent')
  })
})

describe('applyCommands — preview mode', () => {
  test('applies-then-rolls-back: nothing persists', async () => {
    await applyCommands(
      app,
      [
        { path: 'addTodo', args: { id: 1, title: 'ghost' } },
        { path: 'addTag', args: { id: 1, label: 'ghost-tag' } },
      ],
      { mode: 'preview' },
    )

    const { result: todos } = await app.call('listTodos', {})
    const { result: tags } = await app.call('listTags', {})
    expect(todos as unknown[]).toHaveLength(0)
    expect(tags as unknown[]).toHaveLength(0)
  })

  test('returns what WOULD have changed (commands + tablesWritten)', async () => {
    const result = await applyCommands(
      app,
      [
        { path: 'addTodo', args: { id: 1, title: 'ghost' } },
        { path: 'addTag', args: { id: 1, label: 'ghost-tag' } },
      ],
      { mode: 'preview' },
    )

    expect(result.mode).toBe('preview')
    expect(result.commandCount).toBe(2)
    expect(result.commands).toHaveLength(2)
    // The set reflects what a commit WOULD have flushed.
    expect(result.tablesWritten.has('todos')).toBe(true)
    expect(result.tablesWritten.has('tags')).toBe(true)
    // Per-command results survive the rollback — they're snapshotted pre-throw.
    expect(result.results).toHaveLength(2)
  })

  test('preview of a client-id batch sees intra-batch writes before rolling back', async () => {
    const result = await applyCommands(
      app,
      [
        { path: 'addTodo', args: { id: 7, title: 'A' } },
        { path: 'markDone', args: { id: 7 } },
      ],
      { mode: 'preview' },
    )

    // markDone wrote against the row addTodo inserted in the same tx — proving
    // preview runs the real code path, not a mock — then everything rolled back.
    expect(result.tablesWritten.has('todos')).toBe(true)
    const { result: todos } = await app.call('listTodos', {})
    expect(todos as unknown[]).toHaveLength(0)
  })

  test('a failing command in preview surfaces the error (not a phantom success)', async () => {
    await expect(
      applyCommands(
        app,
        [
          { path: 'addTodo', args: { id: 1, title: 'A' } },
          { path: 'boom', args: {} },
        ],
        { mode: 'preview' },
      ),
    ).rejects.toThrow('command boom')
  })
})

describe('applyCommands — back-compat', () => {
  test('app.call still works alongside the batch engine', async () => {
    const { result, tablesWritten } = await app.call('addTodo', { id: 1, title: 'Direct' })
    expect((result as { title: string }[])[0].title).toBe('Direct')
    expect(tablesWritten.has('todos')).toBe(true)

    const { result: todos } = await app.call('listTodos', {})
    expect(todos as unknown[]).toHaveLength(1)
  })
})
