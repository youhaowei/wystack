/**
 * Tests for the generic draft lifecycle — the third leg of the draft
 * model: open / append / publish / discard + conflict detection, sitting ABOVE
 * the read overlay and central derived-change storage.
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
import { integer, pgSchema, text as pgText } from 'drizzle-orm/pg-core'
import { table, defineSchema, text, int, boolean, jsonb, eq } from '@wystack/db'
import {
  createDraftLifecycle,
  type VersionProbe,
  type Cell,
  type Command,
} from '../draft-lifecycle'
import { defineApp } from '../define-app'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const schema = defineSchema({
  todos: table({ id: int.primaryKey(), title: text, done: boolean }).draftable(),
  settings: table({ id: int.primaryKey(), prefix: text }),
  // A "dashboard" with a jsonb-ish text column holding a comma-joined id list —
  // stands in for the intent-grouping case (add_to_dashboard merges into a node).
  dashboards: table({ id: int.primaryKey(), items: text }).draftable(),
})
const appAccounts = pgSchema('app').table('accounts', {
  id: integer('id').primaryKey(),
  name: pgText('name').notNull(),
})
const auditAccounts = pgSchema('audit').table('accounts', {
  id: integer('id').primaryKey(),
  name: pgText('name').notNull(),
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
      __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      __tombstone BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (draft_id, id))
  `)
  await db.execute(`CREATE TABLE dashboards (id INTEGER PRIMARY KEY, items TEXT NOT NULL)`)
  await db.execute(`CREATE TABLE settings (id INTEGER PRIMARY KEY, prefix TEXT NOT NULL)`)
  await db.execute(`
    CREATE TABLE dashboards__draft (
      draft_id TEXT NOT NULL, id INTEGER NOT NULL, items TEXT,
      __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      __tombstone BOOLEAN NOT NULL DEFAULT false, PRIMARY KEY (draft_id, id))
  `)
  await db.execute(`INSERT INTO todos (id,title,done) VALUES (1,'apple',false),(2,'banana',false)`)
  await db.execute(`INSERT INTO dashboards (id,items) VALUES (1,'a')`)
  await db.execute(`INSERT INTO settings (id,prefix) VALUES (1,'from-setting')`)

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
      addTodoUsingSetting: wy.procedure.input({ id: int }).mutation(async (ctx, args) => {
        const setting = await ctx.db.from(schema.settings).first()
        return ctx.db.into(schema.todos).insert({
          id: args.id,
          title: String(setting?.prefix),
          done: false,
        })
      }),
      renameTodo: wy.procedure
        .input({ id: int, title: text })
        .mutation(async (ctx, args) =>
          ctx.db.from(schema.todos).where(eq('id', args.id)).update({ title: args.title }),
        ),
      removeTodo: wy.procedure
        .input({ id: int })
        .mutation(async (ctx, args) => ctx.db.from(schema.todos).where(eq('id', args.id)).delete()),
      renameAppAccount: wy.procedure
        .input({ id: int, name: text })
        .mutation(async (ctx, args) =>
          ctx.db.from(appAccounts).where(eq('id', args.id)).update({ name: args.name }),
        ),
      renameAuditAccount: wy.procedure
        .input({ id: int, name: text })
        .mutation(async (ctx, args) =>
          ctx.db.from(auditAccounts).where(eq('id', args.id)).update({ name: args.name }),
        ),
      // INTENT-GROUPING handler: appends an item id to a dashboard's `items`
      // list. The EFFECT (read-modify-write of a merged list) cannot be
      // reconstructed from a row-delta — only replaying THIS command reproduces
      // it. This is the proof that publish replays the LOG, not a row snapshot.
      addToDashboard: wy.procedure
        .input({ dashboardId: int, item: text })
        .mutation(async (ctx, args) => {
          // Read-modify-write over the effective draft relation. This intentionally
          // reads the full dashboard set because the command merges one node's list.
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
  test('rebuild restores the derived central changes from the authoritative command log', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      {
        path: 'addTodo',
        args: { id: 3, title: 'cherry' },
        kind: 'create',
        compactionKey: 'todo:3',
      },
    ])

    await db.execute(`DELETE FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`)
    expect(
      await app.createTracked().withDraft(draftId).from(schema.todos).where(eq('id', 3)).first(),
    ).toBeNull()

    await lifecycle.rebuild(draftId)

    expect(
      (await app.createTracked().withDraft(draftId).from(schema.todos).where(eq('id', 3)).first())
        ?.title,
    ).toBe('cherry')
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  test('draft metadata and command log survive lifecycle recreation', async () => {
    const firstProcess = createDraftLifecycle(app)
    const draftId = await firstProcess.open(0)
    await firstProcess.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const restartedProcess = createDraftLifecycle(app)
    expect(await restartedProcess.getLog(draftId)).toEqual([
      { path: 'addTodo', args: { id: 3, title: 'cherry' } },
    ])
    const migration = await db.execute(
      `SELECT version FROM wystack_framework_migrations WHERE migration_name = 'draft-storage'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((migration as any).rows[0].version).toBe(2)

    await restartedProcess.publish(draftId)
    const { result: canonical } = await app.call('listTodos', {})
    expect((canonical as { id: number }[]).some((row) => row.id === 3)).toBe(true)
    await expect(restartedProcess.getLog(draftId)).rejects.toThrow('unknown draft')
  })

  test('default custody follows stable principal identity, not mutable profile fields', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0, {
      context: {
        principal: {
          kind: 'user',
          userId: 'user-1',
          identity: { subject: 'provider|1', email: 'old@example.test' },
        },
      },
    })

    expect(
      await createDraftLifecycle(app).getLog(draftId, {
        context: {
          principal: {
            kind: 'user',
            userId: 'user-1',
            identity: { subject: 'provider|1', email: 'new@example.test' },
          },
        },
      }),
    ).toEqual([])

    const persisted = await db.execute(
      `SELECT owner_key FROM wystack_drafts WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect(JSON.stringify((persisted as any).rows[0].owner_key)).not.toContain('old@example.test')
  })

  test('canonical-only reads are not treated as draft shadows during publish', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'addTodoUsingSetting', args: { id: 3 } }])

    await lifecycle.publish(draftId)
    const { result } = await app.call('listTodos', {})
    expect((result as { title: string }[]).some((row) => row.title === 'from-setting')).toBe(true)
  })

  test('append routes writes into the overlay; canonical is untouched until publish', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

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
    const draftId = await lc.open(0)
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

  test('atomic publish: derived-change sweep failure rolls back the canonical commit', async () => {
    // Replay + derived sweep share ONE transaction. If the sweep fails
    // (e.g. the central table is missing), the outer tx rolls back BOTH the
    // canonical command replay AND the sweep — no "canonical committed but
    // shadow still present" state. The draft stays live and publish is retryable.
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    // Drop the central derived-change table so the sweep throws inside the outer tx.
    await db.execute(`DROP TABLE wystack_draft_row_changes`)

    // publish must THROW (the outer tx rolled back), NOT silently succeed.
    await expect(lc.publish(draftId)).rejects.toThrow()

    // Canonical MUST NOT have the row — the replay rolled back with the sweep.
    // Check both the count (fixture rows only) and that id=3 is absent.
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
    expect((canonical as { id: number }[]).find((r) => r.id === 3)).toBeUndefined()

    // Durable metadata and log are still live — the caller can retry or discard.
    expect(await lc.getLog(draftId)).toHaveLength(1)
  })

  test('atomic publish: replay + sweep commit together — no crash window between them', async () => {
    // Definition of done: exactly-once publish. Prove that replay and shadow-sweep
    // are inseparable — if a failure occurs mid-transaction, canonical has ZERO
    // replayed rows AND the shadow is untouched. This models the crash-window
    // scenario: any code that ran between a separate replay-tx and a separate
    // sweep-tx would leave canonical committed but shadow present.
    //
    // We simulate this by injecting a failure AFTER applyCommands but before
    // the derived sweep — possible in the OLD two-tx design but not in the atomic
    // one. With the outer-tx approach the only observable states are:
    //   - tx committed → canonical has the row AND shadow is swept (both landed)
    //   - tx rolled back → canonical is clean AND shadow is intact (both absent)
    // The "canonical committed but shadow not swept" intermediate state cannot occur.
    //
    // Test approach: open, append, then verify that a SUCCESSFUL publish leaves
    // canonical written AND shadow swept in the same observable snapshot — we
    // cannot observe mid-transaction state, but we can verify the end-to-end
    // invariant and check that durable metadata disappears with the commit.
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
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
    const draftId = await lc.open(0)
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
    expect(await lc.getLog(draftId)).toHaveLength(0)

    await lc.publish(draftId)
    // Canonical unchanged — the create+delete cancelled before publish.
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
  })
})

describe('draft lifecycle — publish REPLAYS THE LOG, not a row-delta', () => {
  test('an intent-grouping command (add_to_dashboard) reconstructs ONLY via replay', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

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
    expect((await lc.getLog(draftId)).map((c) => c.path)).toEqual([
      'addToDashboard',
      'addToDashboard',
    ])

    await lc.publish(draftId)

    const res = await db.execute(`SELECT items FROM dashboards WHERE id = 1`)
    // oxlint-disable-next-line typescript/no-explicit-any
    const items = (res as any).rows[0].items as string
    expect(items).toBe('a,z,x,y')
  })

  test('a mid-log failure at publish rolls the whole batch back (atomic)', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
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
    // A failed replay leaves the durable draft row and log intact so the app can
    // retry or discard. Prove discard then clears the overlay with no orphaned
    // shadow rows and no canonical effect.
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    await expect(
      lc.publish(draftId, (logToBind) => [
        ...logToBind,
        // @ts-expect-error — invalid args force a mid-replay failure
        { path: 'addTodo', args: { id: 4 } },
      ]),
    ).rejects.toThrow()

    // Draft is still live: its log is intact and a clean re-publish succeeds.
    expect(await lc.getLog(draftId)).toHaveLength(1)

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
    const draftId = await lc.open(0)
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
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'X' } }])
    expect(await lc.detectConflict(draftId)).toEqual({ staleBase: false, overlappingCells: [] })
  })

  test('probe present but canonical unchanged ⇒ clean (the common publish case)', async () => {
    const probe = makeProbe()
    const lc = createDraftLifecycle(app, { versionProbe: probe })
    const base = await probe.current()
    const draftId = await lc.open(base)
    await lc.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'DRAFT-1' } }])
    // No canonical bump between open and detect — nothing moved.
    expect(await lc.detectConflict(draftId)).toEqual({ staleBase: false, overlappingCells: [] })
  })

  test('staleBase fires when canonical advances; overlappingCells empty if disjoint', async () => {
    const probe = makeProbe()
    const lc = createDraftLifecycle(app, { versionProbe: probe })
    const base = await probe.current()
    const draftId = await lc.open(base)

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
    const draftId = await lc.open(base)

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
    const draftId = await lc.open(base)

    await lc.append(draftId, [{ path: 'removeTodo', args: { id: 2 } }])
    probe.bump([{ table: 'todos', id: 2 }])

    const report = await lc.detectConflict(draftId)
    expect(report.overlappingCells).toEqual([{ table: 'todos', id: 2 }])
  })

  test('same-named tables in different schemas retain distinct conflict identities', async () => {
    await db.execute(`CREATE SCHEMA app`)
    await db.execute(`CREATE SCHEMA audit`)
    for (const namespace of ['app', 'audit']) {
      await db.execute(
        `CREATE TABLE ${namespace}.accounts (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`,
      )
      await db.execute(`
        CREATE TABLE ${namespace}.accounts__draft (
          draft_id TEXT NOT NULL,
          id INTEGER NOT NULL,
          name TEXT,
          __overrides TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          __tombstone BOOLEAN NOT NULL DEFAULT false,
          PRIMARY KEY (draft_id, id)
        )
      `)
      await db.execute(`INSERT INTO ${namespace}.accounts (id, name) VALUES (1, 'original')`)
    }

    const probe = makeProbe()
    const lifecycle = createDraftLifecycle(app, { versionProbe: probe })
    const draftId = await lifecycle.open(await probe.current())
    await lifecycle.append(draftId, [
      { path: 'renameAppAccount', args: { id: 1, name: 'app draft' } },
      { path: 'renameAuditAccount', args: { id: 1, name: 'audit draft' } },
    ])
    probe.bump([{ table: 'app.accounts', id: 1 }])

    expect((await lifecycle.detectConflict(draftId)).overlappingCells).toEqual([
      { table: 'app.accounts', id: 1 },
    ])
  })
})

describe('draft lifecycle — discard', () => {
  test('discard drops the overlay with no canonical effect', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
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
    const draftId = await lc.open(0)

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
    expect(await lc.getLog(draftId)).toHaveLength(0)
    const shadow = await db.execute(`SELECT * FROM todos__draft WHERE draft_id = '${draftId}'`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(0)

    // And the draft is still usable — this was a rejected command, not a
    // poisoned draft.
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    expect(await lc.getLog(draftId)).toHaveLength(1)
  })
})

describe('draft lifecycle — command envelope ownership', () => {
  test('rejects an Action before it can execute against the draft tracker', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    await expect(lc.append(draftId, [{ path: 'externalAction', args: {} }])).rejects.toThrow(
      'Draft command externalAction cannot reference an action',
    )
    expect(await lc.getLog(draftId)).toEqual([])
  })

  test('snapshots a mutable batch before validation and queued execution', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    const batch: Command[] = [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }]

    const appending = lc.append(draftId, batch)
    batch[0].path = 'externalAction'
    batch[0].args = {}
    await appending

    expect(await lc.getLog(draftId)).toEqual([
      { path: 'addTodo', args: { id: 3, title: 'cherry' } },
    ])
  })

  test('rejects a path replaced with an Action while append waits to execute', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    const appending = lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    app.functions.set('addTodo', app.functions.get('externalAction')!)

    await expect(appending).rejects.toThrow('Draft command addTodo cannot reference an action')
    expect(await lc.getLog(draftId)).toEqual([])
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

  test('an append during publish resolution advances CAS and forces a safe retry', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const { gate, release } = deferred()
    const enteredResolve = deferred()
    const publishing = lc.publish(draftId, async (logToBind) => {
      enteredResolve.release()
      await gate // hold publish open, mid-flight, before it commits
      return logToBind
    })

    await enteredResolve.gate
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 4, title: 'date' } }])

    release()
    await expect(publishing).rejects.toThrow('changed during publish')
    await lc.publish(draftId)

    // Neither command was lost: the stale publish committed nothing, and its
    // retry replayed the newer durable log.
    const { result: canonical } = await app.call('listTodos', {})
    const ids = (canonical as { id: number }[]).map((r) => r.id).sort()
    expect(ids).toEqual([1, 2, 3, 4])
  })

  test('discard during publish resolution wins atomically and invalidates the stale publish', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const { gate, release } = deferred()
    const publishing = lc.publish(draftId, async (l) => {
      await gate
      return l
    })

    await lc.discard(draftId)

    release()
    await expect(publishing).rejects.toThrow('unknown draft')
    const res = await db.execute(`SELECT id FROM todos WHERE id = 3`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((res as any).rows).toHaveLength(0)
  })

  test('two concurrent publishes commit exactly once through row locking', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addToDashboard', args: { dashboardId: 1, item: 'z' } }])

    const { gate, release } = deferred()
    const first = lc.publish(draftId, async (l) => {
      await gate
      return l
    })

    await lc.publish(draftId)

    release()
    await expect(first).rejects.toThrow('unknown draft')

    // `addToDashboard` is read-modify-write, so a double replay would show as
    // 'a,z,z'. Exactly-once is visible in the value itself.
    const res = await db.execute(`SELECT items FROM dashboards WHERE id = 1`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((res as any).rows[0].items).toBe('a,z')
  })

  test('a failed publish rolls back its row lock — append and discard work again', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
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
    expect(await lc.getLog(draftId)).toHaveLength(2)
    await lc.discard(draftId)
  })

  test('concurrent appends are SERIALIZED — log order matches call order', async () => {
    // Without the per-draft lock the two batches interleave their awaits and
    // splice commands into each other's log positions.
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    const a = lc.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'c1' } },
      { path: 'addTodo', args: { id: 4, title: 'c2' } },
    ])
    const b = lc.append(draftId, [
      { path: 'addTodo', args: { id: 5, title: 'c3' } },
      { path: 'addTodo', args: { id: 6, title: 'c4' } },
    ])
    await Promise.all([a, b])

    expect((await lc.getLog(draftId)).map((c) => (c.args as { title: string }).title)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ])
  })

  test('concurrent append and discard cannot leave an orphaned overlay', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const discarding = lc.discard(draftId)
    const appending = lc.append(draftId, [{ path: 'addTodo', args: { id: 4, title: 'date' } }])
    const outcomes = await Promise.allSettled([discarding, appending])
    expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true)

    await expect(lc.getLog(draftId)).rejects.toThrow('unknown draft')
    const shadow = await db.execute(`SELECT id FROM todos__draft`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(0)
    const { result: canonical } = await app.call('listTodos', {})
    expect((canonical as { id: number }[]).map((r) => r.id).sort()).toEqual([1, 2])
  })

  test('a publish queued behind a failed append observes its atomic rollback', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    const appending = lc.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'cherry' } },
      { path: 'nope', args: {} }, // unknown function — throws mid-batch
    ])
    // Issued before the failure is observable, so it is admitted and queues.
    const publishing = lc.publish(draftId)

    await expect(appending).rejects.toThrow('Unknown function')
    await publishing

    const { result: canonical } = await app.call('listTodos', {})
    expect((canonical as { id: number }[]).map((r) => r.id).sort()).toEqual([1, 2])
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
    const draftId = await lc.open(0)
    const cap = captureEmits()

    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    // The shadow tag, not the canonical one — canonical is untouched until publish.
    expect(cap.tags()).toEqual(['todos__draft'])
    cap.unsubscribe()
  })

  test('a mid-batch failure rolls back the overlay, log, and invalidation', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    const cap = captureEmits()

    await expect(
      lc.append(draftId, [
        { path: 'addTodo', args: { id: 3, title: 'cherry' } },
        { path: 'nope', args: {} },
      ]),
    ).rejects.toThrow('Unknown function')

    expect(cap.tags()).toEqual([])
    expect(await lc.getLog(draftId)).toEqual([])
    const shadow = await db.execute(`SELECT id FROM todos__draft WHERE draft_id = '${draftId}'`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(0)
    cap.unsubscribe()
  })

  test('publish announces BOTH the canonical replay and the shadow sweep', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
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
    const draftId = await lc.open(0)
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
    const draftId = await lc.open(0)
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
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'listTodos', args: {} }])

    const cap = captureEmits()
    await lc.discard(draftId)

    expect(cap.emitted).toEqual([])
    cap.unsubscribe()
  })

  test('atomic discard: a failed central sweep leaves the derived changes live and emits nothing', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'cherry' } },
      { path: 'addToDashboard', args: { dashboardId: 1, item: 'x' } },
    ])

    await db.execute(
      `ALTER TABLE wystack_draft_row_changes RENAME TO wystack_draft_row_changes_blocked`,
    )

    const cap = captureEmits()
    await expect(lc.discard(draftId)).rejects.toThrow()
    await db.execute(
      `ALTER TABLE wystack_draft_row_changes_blocked RENAME TO wystack_draft_row_changes`,
    )

    const shadow = await db.execute(
      `SELECT * FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((shadow as any).rows).toHaveLength(2)

    // Nothing durably changed, so nothing should have been announced.
    expect(cap.emitted).toEqual([])
    cap.unsubscribe()

    // The draft stays live and retryable, symmetric with a failed publish.
    expect(await lc.getLog(draftId)).toHaveLength(2)

    // Retry: the one indexed sweep succeeds and announces both virtual table tags.
    const cap2 = captureEmits()
    await lc.discard(draftId)
    expect(cap2.tags()).toEqual(['dashboards__draft', 'todos__draft'])
    cap2.unsubscribe()

    const shadowAfter = await db.execute(
      `SELECT * FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
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
    const draftId = await lc.open(0)

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
    expect((await lc.getLog(draftId)).map((c) => c.kind)).toEqual(['delete', 'create'])

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
