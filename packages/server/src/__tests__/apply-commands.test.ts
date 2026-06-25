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
    expect(result.commands).toHaveLength(2)

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

    expect(result.commands).toHaveLength(2)
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

    // results[i].value is commands[i]'s handler return — same value app.call surfaces.
    expect(result.results).toHaveLength(2)
    const [todo, tag] = result.results
    expect((todo.value as { title?: string }[])[0].title).toBe('A')
    expect((tag.value as { label?: string }[])[0].label).toBe('urgent')
  })

  test('echoes each command id onto its result for nominal correlation', async () => {
    const result = await applyCommands(
      app,
      [
        { id: 'cmd-todo', path: 'addTodo', args: { id: 1, title: 'A' } },
        { id: 'cmd-tag', path: 'addTag', args: { id: 1, label: 'urgent' } },
      ],
      { mode: 'commit' },
    )

    // A consumer maps a result back to its command by id, not by array position —
    // the key the agent retry loops need when a batch is filtered or partly retried.
    const byId = new Map(result.results.map((r) => [r.id, r.value]))
    expect((byId.get('cmd-todo') as { title?: string }[])[0].title).toBe('A')
    expect((byId.get('cmd-tag') as { label?: string }[])[0].label).toBe('urgent')
  })

  test('a command without an id gets an undefined result id (correlation falls back to order)', async () => {
    const result = await applyCommands(app, [{ path: 'addTodo', args: { id: 1, title: 'A' } }], {
      mode: 'commit',
    })

    expect(result.results[0].id).toBeUndefined()
    expect((result.results[0].value as { title?: string }[])[0].title).toBe('A')
  })

  test('an empty batch is a no-op: empty results, empty tablesWritten, nothing persists', async () => {
    const result = await applyCommands(app, [], { mode: 'commit' })

    expect(result.mode).toBe('commit')
    expect(result.commands).toHaveLength(0)
    expect(result.results).toHaveLength(0)
    expect(result.tablesWritten.size).toBe(0)

    const { result: todos } = await app.call('listTodos', {})
    expect(todos as unknown[]).toHaveLength(0)
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

  test('an empty batch rolls back cleanly and returns an empty result', async () => {
    const result = await applyCommands(app, [], { mode: 'preview' })

    expect(result.mode).toBe('preview')
    expect(result.commands).toHaveLength(0)
    expect(result.results).toHaveLength(0)
    expect(result.tablesWritten.size).toBe(0)
  })
})

describe('applyCommands — result is a snapshot', () => {
  test('mutating the input batch after the call does not mutate result.commands', async () => {
    const batch = [{ path: 'addTodo', args: { id: 1, title: 'A' } }]
    const result = await applyCommands(app, batch, { mode: 'commit' })

    // The engine copies the batch (`[...batch]`); a caller reusing its array must
    // not retroactively alter what the result reports it applied.
    batch[0] = { path: 'boom', args: {} }
    expect(result.commands).toHaveLength(1)
    expect(result.commands[0].path).toBe('addTodo')
  })
})

describe('applyCommands — coexists with app.call', () => {
  test('a commit batch then a plain app.call both land, app state stays clean', async () => {
    await applyCommands(app, [{ path: 'addTodo', args: { id: 1, title: 'batched' } }], {
      mode: 'commit',
    })

    const { result, tablesWritten } = await app.call('addTodo', { id: 2, title: 'direct' })
    expect((result as { title: string }[])[0].title).toBe('direct')
    expect(tablesWritten.has('todos')).toBe(true)

    // The batch engine left no residual tx open / tracker bleed — both rows persist.
    const { result: todos } = await app.call('listTodos', {})
    expect(todos as unknown[]).toHaveLength(2)
  })
})

describe('applyCommands — outer-tx param (commit mode)', () => {
  // These tests prove the atomic-publish contract: when `opts.tx` is supplied,
  // applyCommands runs commands directly against it (no nested transaction), so
  // caller bookkeeping (e.g. log sweep) and the command replay share ONE commit.
  // This is the crash-window fix — no gap between "canonical committed" and
  // "log deleted" across which a restart could double-replay.

  test('commands run inside the caller-supplied tx and persist on outer commit', async () => {
    const outer = app.createTracked()
    let commitResult: Awaited<ReturnType<typeof applyCommands>> | undefined
    await outer.transaction(async (tx) => {
      commitResult = await applyCommands(
        app,
        [{ path: 'addTodo', args: { id: 1, title: 'atomic' } }],
        { mode: 'commit', tx },
      )
    })

    // The outer transaction committed — the command row must persist.
    const { result: todos } = await app.call('listTodos', {})
    expect(todos as unknown[]).toHaveLength(1)
    expect(commitResult!.mode).toBe('commit')
    expect(commitResult!.commands).toHaveLength(1)
  })

  test('outer tx rollback rolls back the command replay (atomicity: no canonical write without log sweep)', async () => {
    // Simulate the crash-window scenario in reverse: caller throws AFTER
    // applyCommands returns (e.g. log sweep failed) — the whole tx must roll back,
    // including the command replay that already ran inside it.
    const outer = app.createTracked()
    await expect(
      outer.transaction(async (tx) => {
        await applyCommands(
          app,
          [{ path: 'addTodo', args: { id: 1, title: 'should-not-persist' } }],
          { mode: 'commit', tx },
        )
        // Bookkeeping step fails (e.g. log DELETE throws) — simulate with a throw.
        throw new Error('log sweep failed')
      }),
    ).rejects.toThrow('log sweep failed')

    // The command replay must NOT have persisted — it was inside the rolled-back tx.
    const { result: todos } = await app.call('listTodos', {})
    expect(todos as unknown[]).toHaveLength(0)
  })

  test('tablesWritten is populated from the supplied tx and reflects command writes', async () => {
    const outer = app.createTracked()
    let commitResult: Awaited<ReturnType<typeof applyCommands>> | undefined
    await outer.transaction(async (tx) => {
      commitResult = await applyCommands(
        app,
        [
          { path: 'addTodo', args: { id: 1, title: 'A' } },
          { path: 'addTag', args: { id: 1, label: 'urgent' } },
        ],
        { mode: 'commit', tx },
      )
    })

    expect(commitResult!.tablesWritten.has('todos')).toBe(true)
    expect(commitResult!.tablesWritten.has('tags')).toBe(true)
    expect(commitResult!.tablesWritten.size).toBe(2)
  })

  test('tablesWritten is snapshotted from the supplied tx handle, not from a separately-opened tracker', async () => {
    // Load-bearing: the crash-window fix requires `applyCommands` to run against the
    // CALLER'S tx, not to open its own inner transaction. Proof: we observe that
    // `tx.tablesWritten` is populated INSIDE the outer callback (before outer commits),
    // confirming writes accumulate on the supplied handle. An incorrect implementation
    // that opened its own inner tx would accumulate writes on a DIFFERENT inner handle —
    // `tx.tablesWritten` would remain empty until the inner tx committed.
    const outer = app.createTracked()
    let txTablesWrittenMidCallback: Set<string> | undefined
    let commitResult: Awaited<ReturnType<typeof applyCommands>> | undefined
    await outer.transaction(async (tx) => {
      commitResult = await applyCommands(
        app,
        [{ path: 'addTodo', args: { id: 1, title: 'source-check' } }],
        { mode: 'commit', tx },
      )
      // Capture tx.tablesWritten INSIDE the callback (before outer tx commits).
      // If applyCommands ran against the supplied tx directly, writes are already here.
      txTablesWrittenMidCallback = new Set(tx.tablesWritten)
    })

    // The supplied tx's set was populated mid-callback — applyCommands ran flat against it.
    expect(txTablesWrittenMidCallback!.has('todos')).toBe(true)
    // The returned CommitResult snapshotted the same set.
    expect(commitResult!.tablesWritten.has('todos')).toBe(true)
  })

  test('a mid-batch failure inside the outer tx rolls back all commands', async () => {
    const outer = app.createTracked()
    await expect(
      outer.transaction(async (tx) => {
        await applyCommands(
          app,
          [
            { path: 'addTodo', args: { id: 1, title: 'before-boom' } },
            { path: 'boom', args: {} },
          ],
          { mode: 'commit', tx },
        )
      }),
    ).rejects.toThrow('command boom')

    // All-or-nothing: the pre-failure command must not persist.
    const { result: todos } = await app.call('listTodos', {})
    expect(todos as unknown[]).toHaveLength(0)
  })

  test('outer-tx path dispatches flat — does not call tx.transaction() on the supplied handle', async () => {
    // Load-bearing: the atomicity guarantee depends on commands running directly
    // against the caller's tx, not inside a NESTED tx that commits independently.
    // A nested tx would commit before the outer (caller) tx, re-opening the crash
    // window. We verify the flat-dispatch contract by intercepting tx.transaction:
    // if it is ever called, the spy throws, failing the test.
    const outer = app.createTracked()
    await outer.transaction(async (tx) => {
      // Wrap the tx in a Proxy that throws if .transaction() is called. A correct
      // implementation never calls it; an incorrect implementation (nested tx) would
      // trigger the guard immediately.
      const guardedTx = new Proxy(tx, {
        get(target, prop) {
          if (prop === 'transaction') {
            return () => {
              throw new Error(
                'applyCommands (outer-tx path) must not call tx.transaction() — flat dispatch required',
              )
            }
          }
          return Reflect.get(target, prop)
        },
      })
      // Should not throw — applyAll runs flat against guardedTx.
      await applyCommands(app, [{ path: 'addTodo', args: { id: 99, title: 'flat' } }], {
        mode: 'commit',
        tx: guardedTx,
      })
    })

    const { result: todos } = await app.call('listTodos', {})
    expect(todos as unknown[]).toHaveLength(1)
  })
})
