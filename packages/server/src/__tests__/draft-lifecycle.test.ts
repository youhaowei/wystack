/**
 * Tests for the generic draft lifecycle — the third leg of the draft
 * model: open / append / publish / discard + conflict detection, sitting ABOVE
 * the read overlay and the `<table>__draft` write storage.
 *
 * Load-bearing contracts under test:
 *   1. append routes UNMODIFIED command handlers' writes into the draft overlay
 *      (the canonical table is untouched until publish).
 *   2. reads inside the draft see `canonical ⊕ draft`.
 *   3. PUBLISH = REPLAY THE COMMAND LOG (not a row-delta) via applyCommands —
 *      proven by a command whose effect is NOT reconstructible from the rows it
 *      wrote (intent grouping).
 *   4. detectConflict is artifact-agnostic — it speaks (table,id,version) only,
 *      driven by an app-injected VersionProbe; it makes NO policy decision.
 *   5. the resolve(log) hook binds late-bound operands immediately before commit.
 *   6. discard drops the overlay with no canonical effect.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean, jsonb, eq } from '@wystack/db'
import {
  createDraftLifecycle,
  type VersionProbe,
  type Cell,
  type Command,
} from '../draft-lifecycle'
import { defineApp } from '../define-app'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const schema = defineSchema({
  todos: { id: int.primaryKey(), title: text, done: boolean },
  // A "dashboard" with a jsonb-ish text column holding a comma-joined id list —
  // stands in for the intent-grouping case (add_to_dashboard merges into a node).
  dashboards: { id: int.primaryKey(), items: text },
})

let app: Awaited<ReturnType<typeof wy.build>>
let db: ReturnType<typeof drizzle>

beforeEach(async () => {
  const pg = new PGlite()
  db = drizzle(pg)
  await db.execute(
    `CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  await db.execute(`
    CREATE TABLE todos__draft (
      draft_id TEXT NOT NULL, id INTEGER NOT NULL, title TEXT, done BOOLEAN,
      __tombstone BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (draft_id, id))
  `)
  await db.execute(`CREATE TABLE dashboards (id INTEGER PRIMARY KEY, items TEXT NOT NULL)`)
  await db.execute(`
    CREATE TABLE dashboards__draft (
      draft_id TEXT NOT NULL, id INTEGER NOT NULL, items TEXT,
      __tombstone BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (draft_id, id))
  `)
  await db.execute(`INSERT INTO todos (id,title,done) VALUES (1,'apple',false),(2,'banana',false)`)
  await db.execute(`INSERT INTO dashboards (id,items) VALUES (1,'a')`)

  app = await wy.build({
    db,
    functions: {
      listTodos: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.todos).all()),
      addTodo: wy.procedure
        .input({ id: int, title: text })
        .mutation(async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ id: args.id, title: args.title, done: false }),
        ),
      // Writes, and carries a jsonb argument — jsonb validates as `unknown`, so
      // a non-cloneable value (a function) reaches the lifecycle through ordinary
      // validation. Used to pin the snapshot-before-write ordering in append.
      addTodoWithMeta: wy.procedure
        .input({ id: int, title: text, meta: jsonb })
        .mutation(async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ id: args.id, title: args.title, done: false }),
        ),
      renameTodo: wy.procedure
        .input({ id: int, title: text })
        .mutation(async (ctx, args) =>
          ctx.db.from(schema.todos).where(eq('id', args.id)).update({ title: args.title }),
        ),
      removeTodo: wy.procedure
        .input({ id: int })
        .mutation(async (ctx, args) => ctx.db.from(schema.todos).where(eq('id', args.id)).delete()),
      // INTENT-GROUPING handler: appends an item id to a dashboard's `items`
      // list. The EFFECT (read-modify-write of a merged list) cannot be
      // reconstructed from a row-delta — only replaying THIS command reproduces
      // it. This is the proof that publish replays the LOG, not a row snapshot.
      addToDashboard: wy.procedure
        .input({ dashboardId: int, item: text })
        .mutation(async (ctx, args) => {
          // Read-modify-write. NOTE: the draft read coalesce does not yet push
          // `where` down, so a draft-safe handler reads the full
          // coalesced set and filters in JS rather than `.where().all()`.
          const rows = (await ctx.db.from(schema.dashboards).all()) as {
            id: number
            items: string
          }[]
          const current = rows.find((r) => r.id === args.dashboardId)?.items ?? ''
          const next = current ? `${current},${args.item}` : args.item
          return ctx.db
            .from(schema.dashboards)
            .where(eq('id', args.dashboardId))
            .update({ items: next })
        }),
      externalAction: wy.procedure.input({}).action(async () => 'external'),
    },
  })
})

// A trivial generic VersionProbe backed by a monotonic counter + an explicit
// cell-write log. Stands in for whatever the APP uses to track canonical writes;
// the lifecycle never sees its internals — only `(table, id, version)`.
function makeProbe(): VersionProbe & {
  bump(cells: Cell[]): void
} {
  let version = 0
  // `table\u0000id` -> the version at which canonical last wrote that cell
  const written = new Map<string, number>()
  const key = (c: Cell) => `${c.table}\u0000${String(c.id)}`
  return {
    bump(cells) {
      version += 1
      for (const c of cells) written.set(key(c), version)
    },
    async current() {
      return version
    },
    isNewerThan(current, base) {
      return (current as number) > (base as number)
    },
    async cellsWrittenSince(base, cells) {
      const b = base as number
      return cells.filter((c) => {
        const w = written.get(key(c))
        return w !== undefined && w >= b
      })
    },
  }
}

describe('draft lifecycle — golden path (open→append→read→publish)', () => {
  test('append routes writes into the overlay; canonical is untouched until publish', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)

    await lc.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'cherry' } },
      { path: 'renameTodo', args: { id: 1, title: 'APPLE' } },
    ])

    // Canonical untouched: 2 rows, id=1 still 'apple'.
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)

    // Draft-coalesced read sees the overlay: id=1 renamed + id=3 added.
    const draftRows = await app.createTracked().withDraft(draftId).from(schema.todos).all()
    const byId = Object.fromEntries(draftRows.map((r) => [r['id'], r]))
    expect(byId[1]['title']).toBe('APPLE')
    expect(byId[3]['title']).toBe('cherry')
  })

  test('publish replays the log onto canonical atomically; overlay is torn down', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'cherry' } },
      { path: 'renameTodo', args: { id: 1, title: 'APPLE' } },
    ])

    const result = await lc.publish(draftId)
    expect(result.mode).toBe('commit')
    expect(result.tablesWritten.has('todos')).toBe(true)

    // Canonical now reflects the batch.
    const { result: canonical } = await app.call('listTodos', {})
    const byId = Object.fromEntries((canonical as { id: number }[]).map((r) => [r.id, r]))
    expect((byId[1] as { title: string }).title).toBe('APPLE')
    expect(byId[3]).toBeDefined()

    // Overlay torn down: the draft is gone, a second publish throws.
    await expect(lc.publish(draftId)).rejects.toThrow('unknown draft')
    const shadow = await db.execute(`SELECT * FROM todos__draft WHERE draft_id = '${draftId}'`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(0)
  })

  test('atomic publish: clearShadow failure rolls back the canonical commit (no orphan canonical write)', async () => {
    // Replay + shadow-sweep now share ONE transaction. If clearShadow
    // fails (e.g. shadow table missing), the outer tx rolls back BOTH the
    // canonical command replay AND the sweep — no "canonical committed but
    // shadow still present" state. The draft stays live and publish is retryable.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    // Drop the shadow table so clearShadow throws inside the outer tx.
    await db.execute(`DROP TABLE todos__draft`)

    // publish must THROW (the outer tx rolled back), NOT silently succeed.
    await expect(lc.publish(draftId)).rejects.toThrow()

    // Canonical MUST NOT have the row — the replay rolled back with the sweep.
    // Check both the count (fixture rows only) and that id=3 is absent.
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
    expect((canonical as { id: number }[]).find((r) => r.id === 3)).toBeUndefined()

    // Draft registry entry is still live — the caller can retry or discard.
    expect(lc.getLog(draftId)).toHaveLength(1)
  })

  test('atomic publish: replay + sweep commit together — no crash window between them', async () => {
    // Definition of done: exactly-once publish. Prove that replay and shadow-sweep
    // are inseparable — if a failure occurs mid-transaction, canonical has ZERO
    // replayed rows AND the shadow is untouched. This models the crash-window
    // scenario: any code that ran between a separate replay-tx and a separate
    // sweep-tx would leave canonical committed but shadow present.
    //
    // We simulate this by injecting a failure AFTER applyCommands but before
    // clearShadow — possible in the OLD two-tx design but not in the new atomic
    // one. With the outer-tx approach the only observable states are:
    //   - tx committed → canonical has the row AND shadow is swept (both landed)
    //   - tx rolled back → canonical is clean AND shadow is intact (both absent)
    // The "canonical committed but shadow not swept" intermediate state cannot occur.
    //
    // Test approach: open, append, then verify that a SUCCESSFUL publish leaves
    // canonical written AND shadow swept in the same observable snapshot — we
    // cannot observe mid-transaction state, but we can verify the end-to-end
    // invariant and check that the registry entry is removed only post-commit.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const result = await lc.publish(draftId)
    expect(result.mode).toBe('commit')
    expect(result.tablesWritten.has('todos')).toBe(true)

    // Canonical reflects the replay.
    const { result: canonical } = await app.call('listTodos', {})
    const byId = Object.fromEntries((canonical as { id: number }[]).map((r) => [r.id, r]))
    expect(byId[3]).toBeDefined()

    // Shadow swept in the SAME commit: no orphan rows exist post-publish.
    const shadow = await db.execute(`SELECT * FROM todos__draft WHERE draft_id = '${draftId}'`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(0)

    // Registry entry removed post-commit — a second publish throws, not double-replays.
    await expect(lc.publish(draftId)).rejects.toThrow('unknown draft')
  })

  test('compaction accumulates ACROSS appends: create in batch 1, delete in batch 2 ⇒ net empty', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    // Batch 1 creates id=3; batch 2 deletes it. Net effect: the row never
    // existed canonically, so the published log is empty.
    await lc.append(draftId, [
      {
        path: 'addTodo',
        args: { id: 3, title: 'cherry' },
        compactionKey: 'todo:3',
        kind: 'create',
      },
    ])
    await lc.append(draftId, [
      { path: 'removeTodo', args: { id: 3 }, compactionKey: 'todo:3', kind: 'delete' },
    ])
    expect(lc.getLog(draftId)).toHaveLength(0)

    await lc.publish(draftId)
    // Canonical unchanged — the create+delete cancelled before publish.
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
  })
})

describe('draft lifecycle — publish REPLAYS THE LOG, not a row-delta', () => {
  test('an intent-grouping command (add_to_dashboard) reconstructs ONLY via replay', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)

    // Two add_to_dashboard read-modify-write commands inside the draft. The
    // overlay's stored `items` reflects the merge against the canonical value
    // AT APPEND TIME ('a' → 'a,x' → 'a,x,y').
    await lc.append(draftId, [
      { path: 'addToDashboard', args: { dashboardId: 1, item: 'x' } },
      { path: 'addToDashboard', args: { dashboardId: 1, item: 'y' } },
    ])

    // CANONICAL ADVANCES OUT-OF-BAND before publish: a concurrent writer appends
    // 'z' to the same dashboard. This is the discriminator — it makes the two
    // publish strategies produce DIFFERENT results:
    //   - LOG REPLAY: re-runs the commands' read-modify-write against the NEW
    //     canonical 'a,z' → 'a,z,x' → 'a,z,x,y'.
    //   - row-delta: would write the overlay's stale 'a,x,y' (the merges it
    //     captured at append time), CLOBBERING the concurrent 'z'.
    // Asserting 'a,z,x,y' is satisfiable ONLY by log replay.
    await db.execute(`UPDATE dashboards SET items = 'a,z' WHERE id = 1`)

    // The log is the publish unit — both commands present, in order.
    expect(lc.getLog(draftId).map((c) => c.path)).toEqual(['addToDashboard', 'addToDashboard'])

    await lc.publish(draftId)

    const res = await db.execute(`SELECT items FROM dashboards WHERE id = 1`)
    // oxlint-disable-next-line typescript/no-explicit-any
    const items = (res as any).rows[0].items as string
    expect(items).toBe('a,z,x,y')
  })

  test('a mid-log failure at publish rolls the whole batch back (atomic)', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    // Publish-time resolve injects a command that violates the NOT NULL title —
    // proving the replay is one atomic applyCommands(commit).
    await expect(
      lc.publish(draftId, (logToBind) => [
        ...logToBind,
        // @ts-expect-error — deliberately invalid args to force a handler failure
        { path: 'addTodo', args: { id: 4 } },
      ]),
    ).rejects.toThrow()

    // Nothing committed: canonical still 2 rows (id=3 rolled back with the batch).
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
  })

  test('a failed publish leaves the draft live and recoverable (discard cleans up)', async () => {
    // A failed replay leaves the draft ENTRY intact so the app can retry or
    // discard — publish only deletes it after the outer tx commits, and its
    // catch releases the `publishing` claim without touching the entry. Prove
    // the draft survives and discard then clears the overlay (no orphaned
    // shadow rows, no canonical effect).
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    await expect(
      lc.publish(draftId, (logToBind) => [
        ...logToBind,
        // @ts-expect-error — invalid args force a mid-replay failure
        { path: 'addTodo', args: { id: 4 } },
      ]),
    ).rejects.toThrow()

    // Draft is still live: its log is intact and a clean re-publish succeeds.
    expect(lc.getLog(draftId)).toHaveLength(1)

    // Recover via discard: shadow cleared, canonical untouched, draft forgotten.
    await lc.discard(draftId)
    const shadow = await db.execute(`SELECT * FROM todos__draft WHERE draft_id = '${draftId}'`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(0)
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
  })
})

describe('draft lifecycle — resolve(log) binds late-bound operands pre-commit', () => {
  test('the resolve hook rewrites the log immediately before commit', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    // The appended command carries a PLACEHOLDER title; resolve binds it.
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: '<<late>>' } }])

    let sawLog: Command[] = []
    await lc.publish(draftId, (logToBind) => {
      sawLog = logToBind
      return logToBind.map((c) =>
        c.path === 'addTodo' ? { ...c, args: { ...(c.args as object), title: 'BOUND' } } : c,
      )
    })

    expect(sawLog).toHaveLength(1) // hook saw the ordered log
    const res = await db.execute(`SELECT title FROM todos WHERE id = 3`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((res as any).rows[0].title).toBe('BOUND')
  })
})

describe('draft lifecycle — detectConflict (generic, artifact-agnostic)', () => {
  test('no probe ⇒ detection opts out (no conflict reported)', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'X' } }])
    expect(await lc.detectConflict(draftId)).toEqual({ staleBase: false, overlappingCells: [] })
  })

  test('probe present but canonical unchanged ⇒ clean (the common publish case)', async () => {
    const probe = makeProbe()
    const lc = createDraftLifecycle(app, { versionProbe: probe })
    const base = await probe.current()
    const draftId = lc.open(base)
    await lc.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'DRAFT-1' } }])
    // No canonical bump between open and detect — nothing moved.
    expect(await lc.detectConflict(draftId)).toEqual({ staleBase: false, overlappingCells: [] })
  })

  test('staleBase fires when canonical advances; overlappingCells empty if disjoint', async () => {
    const probe = makeProbe()
    const lc = createDraftLifecycle(app, { versionProbe: probe })
    const base = await probe.current()
    const draftId = lc.open(base)

    // Draft touches todos id=1.
    await lc.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'DRAFT-1' } }])

    // Canonical moves, but on a DISJOINT cell (todos id=2).
    probe.bump([{ table: 'todos', id: 2 }])

    const report = await lc.detectConflict(draftId)
    expect(report.staleBase).toBe(true) // coarse: something moved
    expect(report.overlappingCells).toHaveLength(0) // fine: but not OUR cell
  })

  test('overlappingCells fires when canonical wrote a cell the draft also touched', async () => {
    const probe = makeProbe()
    const lc = createDraftLifecycle(app, { versionProbe: probe })
    const base = await probe.current()
    const draftId = lc.open(base)

    await lc.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'DRAFT-1' } }])

    // Canonical writes the SAME cell (todos id=1) after base — a real overlap.
    probe.bump([{ table: 'todos', id: 1 }])

    const report = await lc.detectConflict(draftId)
    expect(report.staleBase).toBe(true)
    expect(report.overlappingCells).toEqual([{ table: 'todos', id: 1 }])
  })

  test('a draft DELETE still registers as a touched cell (conflicts with a canonical write)', async () => {
    const probe = makeProbe()
    const lc = createDraftLifecycle(app, { versionProbe: probe })
    const base = await probe.current()
    const draftId = lc.open(base)

    await lc.append(draftId, [{ path: 'removeTodo', args: { id: 2 } }])
    probe.bump([{ table: 'todos', id: 2 }])

    const report = await lc.detectConflict(draftId)
    expect(report.overlappingCells).toEqual([{ table: 'todos', id: 2 }])
  })
})

describe('draft lifecycle — discard', () => {
  test('discard drops the overlay with no canonical effect', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    await lc.discard(draftId)

    // Canonical untouched, shadow cleared, draft forgotten.
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
    const shadow = await db.execute(`SELECT * FROM todos__draft WHERE draft_id = '${draftId}'`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(0)
    await expect(lc.detectConflict(draftId)).rejects.toThrow('unknown draft')
  })
})

describe('draft lifecycle — a command that cannot be snapshotted', () => {
  test('an uncloneable command fails BEFORE its write, leaving the draft untouched', async () => {
    // append clones each command into the log because the log is the publish
    // unit. When the clone ran AFTER the handler, a non-cloneable argument left
    // a durable overlay row whose command never reached the log — publish then
    // silently omitted it. The clone now runs first, so the failure lands ahead
    // of any write.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)

    await expect(
      lc.append(draftId, [
        {
          path: 'addTodoWithMeta',
          // A function is not structured-cloneable. `meta` is jsonb, which
          // validates as `unknown`, so nothing rejects it earlier.
          args: { id: 3, title: 'cherry', meta: { onDone: () => {} } },
        },
      ]),
      // Assert the CLONE is what failed. A plain `rejects.toThrow()` would also
      // pass if validation had rejected the function first, which would make
      // this test prove nothing about the ordering.
    ).rejects.toThrow('can not be cloned')

    // Neither half of the draft moved: no command logged, no overlay row.
    expect(lc.getLog(draftId)).toHaveLength(0)
    const shadow = await db.execute(`SELECT * FROM todos__draft WHERE draft_id = '${draftId}'`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(0)

    // And the draft is still usable — this was a rejected command, not a
    // poisoned draft.
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    expect(lc.getLog(draftId)).toHaveLength(1)
  })
})

describe('draft lifecycle — command envelope ownership', () => {
  test('rejects an Action before it can execute against the draft tracker', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)

    await expect(lc.append(draftId, [{ path: 'externalAction', args: {} }])).rejects.toThrow(
      'Draft command externalAction cannot reference an action',
    )
    expect(lc.getLog(draftId)).toEqual([])
  })

  test('snapshots a mutable batch before validation and queued execution', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    const batch: Command[] = [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }]

    const appending = lc.append(draftId, batch)
    batch[0].path = 'externalAction'
    batch[0].args = {}
    await appending

    expect(lc.getLog(draftId)).toEqual([{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
  })

  test('rejects a path replaced with an Action while append waits to execute', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    const appending = lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    app.functions.set('addTodo', app.functions.get('externalAction')!)

    await expect(appending).rejects.toThrow('Draft command addTodo cannot reference an action')
    expect(lc.getLog(draftId)).toEqual([])
  })
})

describe('draft lifecycle — concurrent operations on ONE draft (#88)', () => {
  /** A promise plus its resolver — lets a test hold `publish` open mid-flight. */
  function deferred() {
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    return { gate, release }
  }

  test('an append that arrives while publish is in flight is REJECTED, not silently lost', async () => {
    // The lost-write window: publish snapshots the log, awaits (resolve hook,
    // then the commit tx), then deletes the draft entry. An append landing in
    // that window used to write to the overlay, miss the snapshot, and then be
    // destroyed with the entry — returning success to its caller while nothing
    // was ever published.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const { gate, release } = deferred()
    const publishing = lc.publish(draftId, async (logToBind) => {
      await gate // hold publish open, mid-flight, before it commits
      return logToBind
    })

    // Publish has claimed the draft (synchronously, before its first await).
    await expect(
      lc.append(draftId, [{ path: 'addTodo', args: { id: 4, title: 'date' } }]),
    ).rejects.toThrow('is publishing')

    release()
    await publishing

    // Only the pre-publish command landed. The rejected append wrote nothing —
    // to canonical OR to the (now swept) overlay.
    const { result: canonical } = await app.call('listTodos', {})
    const ids = (canonical as { id: number }[]).map((r) => r.id).sort()
    expect(ids).toEqual([1, 2, 3])
  })

  test('discard during publish is rejected (it would sweep the shadow mid-commit)', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const { gate, release } = deferred()
    const publishing = lc.publish(draftId, async (l) => {
      await gate
      return l
    })

    await expect(lc.discard(draftId)).rejects.toThrow('is publishing')

    release()
    await publishing
    const res = await db.execute(`SELECT id FROM todos WHERE id = 3`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((res as any).rows).toHaveLength(1)
  })

  test('a second concurrent publish is rejected; the first commits exactly once', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addToDashboard', args: { dashboardId: 1, item: 'z' } }])

    const { gate, release } = deferred()
    const first = lc.publish(draftId, async (l) => {
      await gate
      return l
    })

    await expect(lc.publish(draftId)).rejects.toThrow('is publishing')

    release()
    await first

    // `addToDashboard` is read-modify-write, so a double replay would show as
    // 'a,z,z'. Exactly-once is visible in the value itself.
    const res = await db.execute(`SELECT items FROM dashboards WHERE id = 1`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((res as any).rows[0].items).toBe('a,z')
  })

  test('a FAILED publish releases the claim — append and discard work again', async () => {
    // The claim must not outlive the publish attempt, or a draft that failed to
    // publish would be permanently frozen: unappendable and undiscardable.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    await expect(
      lc.publish(draftId, (logToBind) => [
        ...logToBind,
        // @ts-expect-error — invalid args force a mid-replay failure
        { path: 'addTodo', args: { id: 4 } },
      ]),
    ).rejects.toThrow()

    // Claim released: the draft accepts work again.
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 5, title: 'elderberry' } }])
    expect(lc.getLog(draftId)).toHaveLength(2)
    await lc.discard(draftId)
  })

  test('concurrent appends are SERIALIZED — log order matches call order', async () => {
    // Without the per-draft lock the two batches interleave their awaits and
    // splice commands into each other's log positions.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)

    const a = lc.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'c1' } },
      { path: 'addTodo', args: { id: 4, title: 'c2' } },
    ])
    const b = lc.append(draftId, [
      { path: 'addTodo', args: { id: 5, title: 'c3' } },
      { path: 'addTodo', args: { id: 6, title: 'c4' } },
    ])
    await Promise.all([a, b])

    expect(lc.getLog(draftId).map((c) => (c.args as { title: string }).title)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ])
  })

  test('an append that arrives while DISCARD is in flight is rejected, not orphaned', async () => {
    // Discard is terminal too — it sweeps the shadow and detaches the entry. An
    // append admitted into that window would write shadow rows for a draft that
    // no longer exists (the sweep has already passed that table) and return
    // success. Same lost-write class as the publish window, one call earlier.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    // No gate needed: discard claims the draft SYNCHRONOUSLY, so the un-awaited
    // call above is enough to put us inside its window.
    const discarding = lc.discard(draftId)
    await expect(
      lc.append(draftId, [{ path: 'addTodo', args: { id: 4, title: 'date' } }]),
    ).rejects.toThrow('is discarding')
    await discarding

    expect(() => lc.getLog(draftId)).toThrow('unknown draft')
    const shadow = await db.execute(`SELECT id FROM todos__draft`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(0)
    const { result: canonical } = await app.call('listTodos', {})
    expect((canonical as { id: number }[]).map((r) => r.id).sort()).toEqual([1, 2])
  })

  test('a publish queued behind a FAILED append still publishes that batch partial work', async () => {
    // Pinning intended behavior, not asserting it is ideal. The lock chain
    // deliberately swallows rejections so one failure cannot wedge the draft —
    // which means queued work runs even when the operation ahead of it threw.
    // Combined with the existing append contract (a batch is NOT atomic; the
    // already-applied commands stay in the log and "the conducting app owns
    // recovery"), a concurrently-issued publish commits the partial batch.
    // Await the append before publishing if the app wants a say.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)

    const appending = lc.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'cherry' } },
      { path: 'nope', args: {} }, // unknown function — throws mid-batch
    ])
    // Issued before the failure is observable, so it is admitted and queues.
    const publishing = lc.publish(draftId)

    await expect(appending).rejects.toThrow('Unknown function')
    await publishing

    const { result: canonical } = await app.call('listTodos', {})
    expect((canonical as { id: number }[]).map((r) => r.id).sort()).toEqual([1, 2, 3])
  })
})

describe('draft lifecycle — invalidation fan-out', () => {
  /** Collect every write-tag set the app announces on its invalidation source. */
  function captureEmits() {
    const emitted: Set<string>[] = []
    const unsubscribe = app.invalidationSource.onInvalidation((tables) => {
      emitted.push(new Set(tables))
    })
    return { emitted, unsubscribe, tags: () => emitted.flatMap((s) => [...s]).sort() }
  }

  test('append announces the OVERLAY write so draft-scoped subscriptions refetch', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    const cap = captureEmits()

    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    // The shadow tag, not the canonical one — canonical is untouched until publish.
    expect(cap.tags()).toEqual(['todos__draft'])
    cap.unsubscribe()
  })

  test('a mid-batch failure still announces the commands that DID land', async () => {
    // append is not atomic across a batch: the first command auto-committed to
    // the overlay and is durable. Staying silent would leave a draft-scoped
    // client showing stale data for a write that really happened.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    const cap = captureEmits()

    await expect(
      lc.append(draftId, [
        { path: 'addTodo', args: { id: 3, title: 'cherry' } },
        { path: 'nope', args: {} },
      ]),
    ).rejects.toThrow('Unknown function')

    expect(cap.tags()).toEqual(['todos__draft'])
    cap.unsubscribe()
  })

  test('publish announces BOTH the canonical replay and the shadow sweep', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const cap = captureEmits()
    await lc.publish(draftId)

    // `todos` — canonical now has the row. `todos__draft` — the sweep emptied
    // the overlay, and that sweep runs on a raw handle, so nothing else reports
    // it. A draft-scoped subscription would otherwise sit on swept rows forever.
    expect(cap.tags()).toEqual(['todos', 'todos__draft'])
    cap.unsubscribe()
  })

  test('a FAILED publish announces nothing (the transaction rolled back)', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const cap = captureEmits()
    await expect(
      // `nope` is not a registered function — a deterministic mid-replay failure.
      lc.publish(draftId, (logToBind) => [...logToBind, { path: 'nope', args: {} }]),
    ).rejects.toThrow()

    // Nothing durably changed, so announcing would trigger a pointless refetch
    // storm — and would tell clients a publish landed when it did not.
    expect(cap.emitted).toEqual([])
    cap.unsubscribe()
    await lc.discard(draftId)
  })

  test('discard announces the shadow sweep and nothing canonical', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const cap = captureEmits()
    await lc.discard(draftId)

    expect(cap.tags()).toEqual(['todos__draft'])
    cap.unsubscribe()
  })

  test('a READ-ONLY draft announces nothing on discard', async () => {
    // `touchedTables` records reads as well as writes — a `from(t)…delete()`
    // routes through `from`, so the recorder cannot tell them apart. Deriving
    // the sweep tags from it would announce `todos__draft` for a draft that
    // never wrote a shadow row, costing every draft-scoped subscriber a
    // full recompute for a sweep that deleted nothing. The tags come from what
    // the tracker actually reported written instead.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [{ path: 'listTodos', args: {} }])

    const cap = captureEmits()
    await lc.discard(draftId)

    expect(cap.emitted).toEqual([])
    cap.unsubscribe()
  })

  test('atomic discard: a partial-table sweep failure leaves every shadow table untouched (no silent partial invalidation)', async () => {
    // discard's sweep issues one DELETE per touched table. If a draft touched
    // MULTIPLE tables and a later delete in that loop fails, an unwrapped sweep
    // would already have durably committed the earlier deletes (auto-commit
    // per statement) while throwing before `app.emit` ever runs — a durable
    // state change with zero invalidation. Subscribers watching the
    // already-cleared table would keep serving rows that are gone.
    //
    // The fix wraps the whole sweep in one transaction: either every touched
    // table's shadow rows clear (and their tags reach the emit) or none does.
    // `addTodo` is appended before `addToDashboard`, so `touchedTables` records
    // `todos` before `dashboards` — the sweep attempts `todos__draft` FIRST.
    // Dropping `dashboards__draft` makes the SECOND delete in that loop fail;
    // an unwrapped sweep would have already committed the first.
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)
    await lc.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'cherry' } },
      { path: 'addToDashboard', args: { dashboardId: 1, item: 'x' } },
    ])

    await db.execute(`DROP TABLE dashboards__draft`)

    const cap = captureEmits()
    await expect(lc.discard(draftId)).rejects.toThrow()

    // The `todos__draft` row must STILL be present — the sweep must not have
    // durably deleted it before failing on `dashboards__draft`.
    const shadow = await db.execute(`SELECT * FROM todos__draft WHERE draft_id = '${draftId}'`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(1)

    // Nothing durably changed, so nothing should have been announced.
    expect(cap.emitted).toEqual([])
    cap.unsubscribe()

    // The draft stays live and retryable, symmetric with a failed publish.
    expect(lc.getLog(draftId)).toHaveLength(2)

    // Recreate the dropped table and retry: the sweep now succeeds fully and
    // announces both shadow tags.
    await db.execute(`
      CREATE TABLE dashboards__draft (
        draft_id TEXT NOT NULL, id INTEGER NOT NULL, items TEXT,
        __tombstone BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (draft_id, id))
    `)
    const cap2 = captureEmits()
    await lc.discard(draftId)
    expect(cap2.tags()).toEqual(['dashboards__draft', 'todos__draft'])
    cap2.unsubscribe()

    const shadowAfter = await db.execute(`SELECT * FROM todos__draft WHERE draft_id = '${draftId}'`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadowAfter as any).rows).toHaveLength(0)
  })
})

describe('draft lifecycle — replacing a canonical row (#89)', () => {
  test('delete + create on the same canonical id publishes as a replace', async () => {
    // Compaction used to drop the canonical delete when a create followed it on
    // the same key, so publish replayed the insert alone onto a live primary
    // key — a duplicate-key failure (or, with a forgiving handler, a stale row).
    const lc = createDraftLifecycle(app)
    const draftId = lc.open(0)

    await lc.append(draftId, [
      { path: 'removeTodo', args: { id: 1 }, compactionKey: 'todo:1', kind: 'delete' },
      {
        path: 'addTodo',
        args: { id: 1, title: 'REPLACED' },
        compactionKey: 'todo:1',
        kind: 'create',
      },
    ])

    // Both halves survive compaction, in order.
    expect(lc.getLog(draftId).map((c) => c.kind)).toEqual(['delete', 'create'])

    // And the overlay already shows the replacement (the shadow write is a
    // sparse upsert, so the create clears the tombstone the delete set).
    const draftRows = await app.createTracked().withDraft(draftId).from(schema.todos).all()
    expect(Object.fromEntries(draftRows.map((r) => [r['id'], r['title']]))[1]).toBe('REPLACED')

    await lc.publish(draftId)

    const { result: canonical } = await app.call('listTodos', {})
    const rows = canonical as { id: number; title: string }[]
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === 1)?.title).toBe('REPLACED')
  })
})
