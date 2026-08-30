/**
 * Tests for the generic draft lifecycle — the third leg of the draft
 * model: open / append / publish / discard + conflict detection, sitting ABOVE
 * the read overlay and central derived-change storage.
 *
 * Load-bearing contracts under test:
 *   1. append routes UNMODIFIED command handlers' writes into the draft overlay
 *      (the canonical table is untouched until publish).
 *   2. reads inside the draft see `canonical ⊕ draft`.
 *   3. publish verifies replay against reviewed changes, then applies those
 *      exact changes instead of re-evaluating intent against newer state.
 *   4. detectConflict is artifact-agnostic — it speaks (table,id,version) only,
 *      driven by an app-injected VersionProbe; it makes NO policy decision.
 *   5. the resolve(log) hook binds late-bound operands immediately before commit.
 *   6. discard drops the overlay with no canonical effect.
 *   7. owner discovery is bounded and ordered by an immutable keyset.
 *   8. initial materialization and draft replacement commit their metadata,
 *      command log, and derived rows as one state change.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { integer, pgSchema, pgTable, text as pgText, varchar } from 'drizzle-orm/pg-core'
import {
  table,
  defineSchema,
  text,
  int,
  boolean,
  jsonb,
  timestamp,
  eq,
  draftInvalidationIdentity,
  ensureRowRevisionStorage,
  jsonNull,
  multiTenant,
} from '@wystack/db'
import { registerTableCapabilities } from '../../../db/src/schema'
import {
  createDraftLifecycle as createProductionDraftLifecycle,
  DEFAULT_OWNED_DRAFT_PAGE_SIZE,
  MAX_DRAFT_SUMMARY_BYTES,
  MAX_DRAFT_SUMMARY_DEPTH,
  MAX_OWNED_DRAFT_PAGE_SIZE,
  DraftConflictError,
  DraftIntegrityError,
  DraftPublishDriftError,
  type VersionProbe,
  type Cell,
  type Command,
  type DraftSummary,
  type DraftLifecycleOptions,
} from '../draft-lifecycle'
import { defineApp } from '../define-app'
import { applyReviewedChanges } from '../draft-review-state'
import { refreshStoredDraftIntegrity } from '../draft-store'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })
const tenantAwareDescriptor = multiTenant()

const schema = defineSchema({
  todos: table({
    id: int.primaryKey(),
    title: text,
    done: boolean,
  }).draftable(),
  versionedTodos: table({ id: int.primaryKey(), title: text, revision: int })
    .revision('revision')
    .draftable(),
  replaceableTodos: table({
    id: int.primaryKey(),
    title: text,
    note: text.nullable(),
  }).draftable(),
  settings: table({ id: int.primaryKey(), prefix: text }),
  // A "dashboard" with a jsonb-ish text column holding a comma-joined id list —
  // stands in for the intent-grouping case (add_to_dashboard merges into a node).
  dashboards: table({ id: int.primaryKey(), items: text }).draftable(),
  documents: table({
    id: int.primaryKey(),
    payload: jsonb.nullable(),
  }).draftable(),
  aCodeParents: table({ id: int.primaryKey(), code: text.unique() }).draftable(),
  zCodeChildren: table({
    id: int.primaryKey(),
    parentCode: text.references('aCodeParents', 'code'),
  }).draftable(),
  // Names intentionally sort child before parent; publish must follow the FK.
  aChildren: table({ id: int.primaryKey(), parentId: int.references('zParents') }).draftable(),
  zParents: table({ id: int.primaryKey(), name: text }).draftable(),
  treeNodes: table({
    id: int.primaryKey(),
    parentId: int.nullable().references('treeNodes'),
  }).draftable(),
  aTimedChildren: table({
    id: int.primaryKey(),
    parentToken: timestamp.references('zTimedParents', 'token'),
  }).draftable(),
  zTimedParents: table({ id: int.primaryKey(), token: timestamp.unique() }).draftable(),
})
const appAccounts = pgSchema('app').table('accounts', {
  id: integer('id').primaryKey(),
  name: pgText('name').notNull(),
})
const auditAccounts = pgSchema('audit').table('accounts', {
  id: integer('id').primaryKey(),
  name: pgText('name').notNull(),
})
const varcharItems = pgTable('varchar_items', {
  id: varchar('id', { length: 12 }).primaryKey(),
  title: pgText('title').notNull(),
})
registerTableCapabilities(appAccounts, { draftable: true })
registerTableCapabilities(auditAccounts, { draftable: true })
registerTableCapabilities(varcharItems, { draftable: true })

let app: Awaited<ReturnType<typeof wy.build>>
let db: ReturnType<typeof drizzle>
let pg: PGlite

/** Most lifecycle scenarios exercise mechanics under an explicitly privileged test host. */
function createDraftLifecycle(
  currentApp: Awaited<ReturnType<typeof wy.build>>,
  opts: DraftLifecycleOptions = {},
) {
  return createProductionDraftLifecycle(currentApp, {
    resolveOwner: () => 'test-owner',
    authorizeGlobalDraft: () => true,
    ...opts,
  })
}

function createOwnedDraftLifecycle() {
  return createProductionDraftLifecycle(app, {
    resolveOwner: (context) => context['owner'],
    authorizeGlobalDraft: () => true,
  })
}

function nestedSummary(depth: number): DraftSummary {
  let summary: DraftSummary = 'leaf'
  for (let current = 0; current < depth; current += 1) summary = { child: summary }
  return summary
}

async function readDraftArtifactCounts() {
  const persisted = await db.execute(`SELECT
    (SELECT count(*) FROM wystack_drafts) AS drafts,
    (SELECT count(*) FROM wystack_draft_commands) AS commands,
    (SELECT count(*) FROM wystack_draft_tables) AS tables,
    (SELECT count(*) FROM wystack_draft_row_changes) AS changes`)
  const row = (persisted as { rows: Array<Record<string, unknown>> }).rows[0]
  return {
    drafts: Number(row?.['drafts']),
    commands: Number(row?.['commands']),
    tables: Number(row?.['tables']),
    changes: Number(row?.['changes']),
  }
}

afterEach(async () => {
  await pg.close()
})

beforeEach(async () => {
  pg = new PGlite()
  db = drizzle(pg)
  await db.execute(
    `CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  await db.execute(`CREATE TABLE dashboards (id INTEGER PRIMARY KEY, items TEXT NOT NULL)`)
  await db.execute(`CREATE TABLE documents (id INTEGER PRIMARY KEY, payload JSONB)`)
  await db.execute(
    `CREATE TABLE "aCodeParents" (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE)`,
  )
  await db.execute(
    `CREATE TABLE "zCodeChildren" (id INTEGER PRIMARY KEY, "parentCode" TEXT NOT NULL REFERENCES "aCodeParents"(code))`,
  )
  await db.execute(`CREATE TABLE "zParents" (id INTEGER PRIMARY KEY, name TEXT NOT NULL)`)
  await db.execute(
    `CREATE TABLE "aChildren" (id INTEGER PRIMARY KEY, "parentId" INTEGER NOT NULL REFERENCES "zParents"(id))`,
  )
  await db.execute(
    `CREATE TABLE "treeNodes" (id INTEGER PRIMARY KEY, "parentId" INTEGER REFERENCES "treeNodes"(id))`,
  )
  await db.execute(
    `CREATE TABLE "zTimedParents" (id INTEGER PRIMARY KEY, token TIMESTAMP NOT NULL UNIQUE)`,
  )
  await db.execute(
    `CREATE TABLE "aTimedChildren" (id INTEGER PRIMARY KEY, "parentToken" TIMESTAMP NOT NULL REFERENCES "zTimedParents"(token))`,
  )
  await db.execute(
    `CREATE TABLE "versionedTodos" (id INTEGER PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL)`,
  )
  await db.execute(
    `CREATE TABLE "replaceableTodos" (id INTEGER PRIMARY KEY, title TEXT NOT NULL, note TEXT)`,
  )
  await db.execute(`CREATE TABLE settings (id INTEGER PRIMARY KEY, prefix TEXT NOT NULL)`)
  await db.execute(`CREATE TABLE varchar_items (id VARCHAR(12) PRIMARY KEY, title TEXT NOT NULL)`)
  await ensureRowRevisionStorage(db)
  await db.execute(`INSERT INTO todos (id,title,done) VALUES (1,'apple',false),(2,'banana',false)`)
  await db.execute(`INSERT INTO dashboards (id,items) VALUES (1,'a')`)
  await db.execute(`INSERT INTO documents (id,payload) VALUES (1,'{}'::jsonb)`)
  await db.execute(`INSERT INTO "aCodeParents" (id,code) VALUES (1,'old'),(2,'stable')`)
  await db.execute(`INSERT INTO "zCodeChildren" (id,"parentCode") VALUES (1,'old')`)
  await db.execute(`INSERT INTO "zParents" (id,name) VALUES (10,'existing')`)
  await db.execute(`INSERT INTO "aChildren" (id,"parentId") VALUES (11,10)`)
  await db.execute(`INSERT INTO "treeNodes" (id,"parentId") VALUES (10,NULL),(11,10)`)
  await db.execute(`INSERT INTO "versionedTodos" (id,title,revision) VALUES (1,'apple',1)`)
  await db.execute(
    `INSERT INTO "replaceableTodos" (id,title,note) VALUES (1,'original','old note')`,
  )
  await db.execute(`INSERT INTO settings (id,prefix) VALUES (1,'from-setting')`)

  app = await wy.build({
    db,
    functions: {
      listTodos: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.todos).all()),
      readTodos: wy.procedure.input({}).command(async (ctx) => ctx.db.from(schema.todos).all()),
      listVersionedTodos: wy.procedure
        .input({})
        .query(async (ctx) => ctx.db.from(schema.versionedTodos).all()),
      listReplaceableTodos: wy.procedure
        .input({})
        .query(async (ctx) => ctx.db.from(schema.replaceableTodos).all()),
      addTodo: wy.procedure
        .input({ id: int, title: text })
        .command(async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ id: args.id, title: args.title, done: false }),
        ),
      canonicalOnlyTodo: wy.procedure
        .input({ id: int, title: text })
        .mutation(async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ id: args.id, title: args.title, done: false }),
        ),
      boom: wy.procedure.input({}).command(async () => {
        throw new Error('command boom')
      }),
      addTodoAt: wy.procedure.input({ id: int, createdAt: timestamp }).command(async (ctx, args) =>
        ctx.db.into(schema.todos).insert({
          id: args.id,
          title: args.createdAt.toISOString(),
          done: false,
        }),
      ),
      addVersionedTodo: wy.procedure
        .input({ id: int, title: text })
        .command(async (ctx, args) =>
          ctx.db.into(schema.versionedTodos).insert({ id: args.id, title: args.title }),
        ),
      removeVersionedTodo: wy.procedure
        .input({ id: int })
        .command(async (ctx, args) =>
          ctx.db.from(schema.versionedTodos).where(eq('id', args.id)).delete(),
        ),
      addReplaceableTodo: wy.procedure
        .input({ id: int, title: text })
        .command(async (ctx, args) =>
          ctx.db.into(schema.replaceableTodos).insert({ id: args.id, title: args.title }),
        ),
      renameVarcharItem: wy.procedure
        .input({ id: text, title: text })
        .command(async (ctx, args) =>
          ctx.db.from(varcharItems).where(eq('id', args.id)).update({ title: args.title }),
        ),
      removeReplaceableTodo: wy.procedure
        .input({ id: int })
        .command(async (ctx, args) =>
          ctx.db.from(schema.replaceableTodos).where(eq('id', args.id)).delete(),
        ),
      // Writes, and carries a jsonb argument — jsonb validates as `unknown`, so
      // a non-cloneable value (a function) reaches the lifecycle through ordinary
      // validation. Used to pin the snapshot-before-write ordering in append.
      addTodoWithMeta: wy.procedure
        .input({ id: int, title: text, meta: jsonb })
        .command(async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ id: args.id, title: args.title, done: false }),
        ),
      addTodoFromMeta: wy.procedure.input({ id: int, meta: jsonb }).command(async (ctx, args) =>
        ctx.db.into(schema.todos).insert({
          id: args.id,
          title: Object.hasOwn(args.meta as object, '__proto__') ? 'present' : 'missing',
          done: false,
        }),
      ),
      addTodoUsingSetting: wy.procedure.input({ id: int }).command(async (ctx, args) => {
        const setting = await ctx.db.from(schema.settings).first()
        return ctx.db.into(schema.todos).insert({
          id: args.id,
          title: String(setting?.prefix),
          done: false,
        })
      }),
      renameTodo: wy.procedure
        .input({ id: int, title: text })
        .command(async (ctx, args) =>
          ctx.db.from(schema.todos).where(eq('id', args.id)).update({ title: args.title }),
        ),
      finishOpenTodos: wy.procedure
        .input({})
        .command(async (ctx) =>
          ctx.db.from(schema.todos).where(eq('done', false)).update({ done: true }),
        ),
      setDocumentPayload: wy.procedure
        .input({ id: int, payload: jsonb })
        .command(async (ctx, args) =>
          ctx.db
            .from(schema.documents)
            .where(eq('id', args.id))
            .update({
              payload: args.payload === null ? jsonNull() : args.payload,
            }),
        ),
      retargetAndRenameCode: wy.procedure
        .input({ childId: int, parentId: int, nextParentCode: text, nextCode: text })
        .command(async (ctx, args) => {
          await ctx.db
            .from(schema.aCodeParents)
            .where(eq('id', args.parentId))
            .update({ code: args.nextCode })
          return ctx.db
            .from(schema.zCodeChildren)
            .where(eq('id', args.childId))
            .update({ parentCode: args.nextParentCode })
        }),
      replaceCodeFamily: wy.procedure
        .input({ childId: int, parentId: int, code: text })
        .command(async (ctx, args) => {
          await ctx.db.from(schema.zCodeChildren).where(eq('id', args.childId)).delete()
          await ctx.db.from(schema.aCodeParents).where(eq('id', args.parentId)).delete()
          await ctx.db.into(schema.aCodeParents).insert({ id: args.parentId, code: args.code })
          return ctx.db
            .into(schema.zCodeChildren)
            .insert({ id: args.childId, parentCode: args.code })
        }),
      addFamily: wy.procedure.input({ parentId: int, childId: int }).command(async (ctx, args) => {
        await ctx.db.into(schema.zParents).insert({ id: args.parentId, name: 'parent' })
        return ctx.db.into(schema.aChildren).insert({ id: args.childId, parentId: args.parentId })
      }),
      removeFamily: wy.procedure
        .input({ parentId: int, childId: int })
        .command(async (ctx, args) => {
          await ctx.db.from(schema.aChildren).where(eq('id', args.childId)).delete()
          return ctx.db.from(schema.zParents).where(eq('id', args.parentId)).delete()
        }),
      addTreePair: wy.procedure
        .input({ parentId: int, childId: int })
        .command(async (ctx, args) => {
          await ctx.db.into(schema.treeNodes).insert({ id: args.parentId, parentId: null })
          return ctx.db.into(schema.treeNodes).insert({ id: args.childId, parentId: args.parentId })
        }),
      removeTreePair: wy.procedure
        .input({ parentId: int, childId: int })
        .command(async (ctx, args) => {
          await ctx.db.from(schema.treeNodes).where(eq('id', args.childId)).delete()
          return ctx.db.from(schema.treeNodes).where(eq('id', args.parentId)).delete()
        }),
      addTimedFamily: wy.procedure
        .input({ parentId: int, childId: int, token: timestamp })
        .command(async (ctx, args) => {
          await ctx.db.into(schema.zTimedParents).insert({ id: args.parentId, token: args.token })
          return ctx.db
            .into(schema.aTimedChildren)
            .insert({ id: args.childId, parentToken: args.token })
        }),
      renameVersionedTodo: wy.procedure
        .input({ id: int, title: text })
        .command(async (ctx, args) =>
          ctx.db.from(schema.versionedTodos).where(eq('id', args.id)).update({ title: args.title }),
        ),
      removeTodo: wy.procedure
        .input({ id: int })
        .command(async (ctx, args) => ctx.db.from(schema.todos).where(eq('id', args.id)).delete()),
      renameAppAccount: wy.procedure
        .input({ id: int, name: text })
        .command(async (ctx, args) =>
          ctx.db.from(appAccounts).where(eq('id', args.id)).update({ name: args.name }),
        ),
      renameAuditAccount: wy.procedure
        .input({ id: int, name: text })
        .command(async (ctx, args) =>
          ctx.db.from(auditAccounts).where(eq('id', args.id)).update({ name: args.name }),
        ),
      // A read-modify-write command makes drift observable: replay on a newer
      // list produces a different proposal, so publish must preserve the draft
      // and ask the application to resolve it.
      addToDashboard: wy.procedure
        .input({ dashboardId: int, item: text })
        .command(async (ctx, args) => {
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
      legacyAddTodo: wy.legacyProcedure
        .input({ id: int, title: text })
        .mutation(async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ id: args.id, title: args.title, done: false }),
        ),
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
  const key = (c: Cell) => `${c.table}\u0000${String(c.tenantId)}\u0000${String(c.id)}`
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

describe('draft lifecycle — global authority and custody', () => {
  const ownerContext = {
    principal: { kind: 'user' as const, userId: 'system-test' },
  }

  test('tenant-aware apps require explicit privileged host authorization for global drafts', async () => {
    const tenantAware = await wy.build({
      db,
      functions: {
        listTodos: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.todos).all()),
      },
      tenancy: tenantAwareDescriptor,
      resolveTenant: () => undefined,
    })
    const lifecycle = createProductionDraftLifecycle(tenantAware)

    // Without the hook the only scope a tenant-aware app can bind is the
    // resolved tenant, and there is none — fail closed either way.
    await expect(lifecycle.open(0, { context: ownerContext })).rejects.toThrow(
      /privileged host context|trusted tenant ID/,
    )
    const privileged = createProductionDraftLifecycle(tenantAware, {
      authorizeGlobalDraft: () => true,
    })
    const draftId = await privileged.open(0, {
      context: ownerContext,
      lookupKey: 'global:one',
    })
    await expect(
      lifecycle.findOwnedByLookupKey('global:one', { context: ownerContext }),
    ).rejects.toThrow(/privileged host context|trusted tenant ID/)
    await expect(
      privileged.findOwnedByLookupKey('global:one', { context: ownerContext }),
    ).resolves.toMatchObject({ draftId })
  })

  test('apps without a tenant dimension open drafts without a global authorization hook', async () => {
    const lifecycle = createProductionDraftLifecycle(app)
    const draftId = await lifecycle.open(0, { context: ownerContext })
    await lifecycle.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }], {
      context: ownerContext,
    })
    await lifecycle.publish(draftId, undefined, { context: ownerContext })

    const { result } = await app.call('listTodos', {})
    expect(result).toContainEqual(expect.objectContaining({ id: 3, title: 'cherry' }))
  })

  test('global drafts require a stable non-null owner', async () => {
    for (const resolvedOwner of [undefined, null]) {
      const lifecycle = createProductionDraftLifecycle(app, {
        resolveOwner: () => resolvedOwner,
        authorizeGlobalDraft: () => true,
      })

      await expect(lifecycle.open(0)).rejects.toThrow('stable owner')
    }
  })

  test('global privilege is reauthorized on every operation without leaking the draft', async () => {
    const lifecycle = createProductionDraftLifecycle(app, {
      authorizeGlobalDraft: ({ context }) => context.globalDraftAccess === true,
    })
    const privileged = { ...ownerContext, globalDraftAccess: true }
    const draftId = await lifecycle.open(0, { context: privileged })
    await lifecycle.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }], {
      context: privileged,
    })

    await expect(lifecycle.getLog(draftId, { context: ownerContext })).rejects.toThrow(
      'unknown draft',
    )
    expect(await lifecycle.getLog(draftId, { context: privileged })).toHaveLength(1)
  })

  test('owner keys are canonically persisted and compared after lifecycle recreation', async () => {
    const resolveOwner = () => new Date('2026-01-01T00:00:00.000Z')
    const first = createProductionDraftLifecycle(app, {
      resolveOwner,
      authorizeGlobalDraft: () => true,
    })
    const draftId = await first.open(0)
    await first.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'date-owned' } }])

    const reopened = createProductionDraftLifecycle(app, {
      resolveOwner,
      authorizeGlobalDraft: () => true,
    })
    expect(await reopened.getLog(draftId)).toHaveLength(1)
    expect(await reopened.inspect(draftId)).toHaveLength(1)
  })

  test('explicit global authority bypasses tenant resolution for a mixed application', async () => {
    let tenantResolutionCalls = 0
    const mixedApp = await wy.build({
      db,
      tenancy: tenantAwareDescriptor,
      resolveTenant: () => {
        tenantResolutionCalls += 1
        throw new Error('global draft must not resolve tenant scope')
      },
      functions: {
        addGlobalTodo: wy.procedure
          .input({ id: int, title: text })
          .command(async (ctx, args) => ctx.db.into(schema.todos).insert({ ...args, done: false })),
      },
    })
    const lifecycle = createProductionDraftLifecycle(mixedApp, {
      authorizeGlobalDraft: () => true,
    })
    const draftId = await lifecycle.open(0, { context: ownerContext })

    await lifecycle.append(draftId, [{ path: 'addGlobalTodo', args: { id: 3, title: 'global' } }], {
      context: ownerContext,
    })
    expect(await lifecycle.inspect(draftId, { context: ownerContext })).toMatchObject([
      { table: 'todos', tenantKey: null, rowKey: { value: 3 } },
    ])
    await lifecycle.publish(draftId, undefined, { context: ownerContext })
    expect(await db.select().from(schema.todos)).toContainEqual({
      id: 3,
      title: 'global',
      done: false,
    })
    expect(tenantResolutionCalls).toBe(0)
  })
})

describe('draft lifecycle — golden path (open→append→read→publish)', () => {
  test('rebase fails closed when materialized row changes disagree with the command log', async () => {
    const lifecycle = createDraftLifecycle(app, { versionProbe: makeProbe() })
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
    await expect(lifecycle.rebase(draftId)).rejects.toBeInstanceOf(DraftIntegrityError)
    expect(
      await app.system
        .createTracked()
        .withDraft(draftId)
        .from(schema.todos)
        .where(eq('id', 3))
        .first(),
    ).toBeNull()
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  test('rebase fails closed when a stored command changes without changing command count', async () => {
    const lifecycle = createDraftLifecycle(app, { versionProbe: makeProbe() })
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    await db.execute(
      `UPDATE wystack_draft_commands
       SET command = '{"path":"addTodo","args":{"id":4,"title":"tampered"}}'
       WHERE draft_id = '${draftId}' AND position = 0`,
    )

    await expect(lifecycle.rebase(draftId)).rejects.toBeInstanceOf(DraftIntegrityError)
    expect(
      (
        await app.system
          .createTracked()
          .withDraft(draftId)
          .from(schema.todos)
          .where(eq('id', 3))
          .first()
      )?.title,
    ).toBe('cherry')
  })

  test('publish rejects corrupt artifacts before invoking the resolve hook', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    await db.execute(`DELETE FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`)
    let resolveCalled = false

    await expect(
      lifecycle.publish(draftId, (log) => {
        resolveCalled = true
        return log
      }),
    ).rejects.toBeInstanceOf(DraftIntegrityError)
    expect(resolveCalled).toBe(false)
  })

  test('explicit rebase rebuilds an intact draft on a newer canonical base', async () => {
    const probe = makeProbe()
    const lifecycle = createDraftLifecycle(app, { versionProbe: probe })
    const draftId = await lifecycle.open(await probe.current())
    await lifecycle.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    probe.bump([{ table: 'todos', id: 2 }])

    await expect(lifecycle.rebase(draftId)).resolves.toEqual({
      staleBase: true,
      overlappingCells: [],
    })
    expect(
      (
        await app.system
          .createTracked()
          .withDraft(draftId)
          .from(schema.todos)
          .where(eq('id', 3))
          .first()
      )?.title,
    ).toBe('cherry')
  })

  /** Conflict acceptance runs without a draft-row lock; a concurrent append wins and the stale rebase fails CAS. */
  test('rebase decisions do not hold the draft row lock while host callbacks run', async () => {
    const probe = makeProbe()
    const lifecycle = createDraftLifecycle(app, { versionProbe: probe })
    const draftId = await lifecycle.open(await probe.current())
    await lifecycle.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'draft' } }])
    probe.bump([{ table: 'todos', id: 1 }])

    let callbackStarted!: () => void
    const started = new Promise<void>((resolve) => {
      callbackStarted = resolve
    })
    let releaseCallback!: () => void
    const release = new Promise<void>((resolve) => {
      releaseCallback = resolve
    })
    const rebasing = lifecycle.rebase(draftId, {
      acceptConflicts: async () => {
        callbackStarted()
        await release
        return true
      },
    })

    await started
    await lifecycle.append(draftId, [{ path: 'renameTodo', args: { id: 2, title: 'concurrent' } }])
    releaseCallback()

    await expect(rebasing).rejects.toThrow('changed during rebase')
    expect(await lifecycle.getLog(draftId)).toHaveLength(2)
  })

  /** A host callback that changes canonical state invalidates the report it accepted and leaves the draft intact. */
  test('rebase rejects canonical version drift introduced during conflict acceptance', async () => {
    const probe = makeProbe()
    const lifecycle = createDraftLifecycle(app, { versionProbe: probe })
    const draftId = await lifecycle.open(await probe.current())
    await lifecycle.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'draft-title' } }])
    probe.bump([{ table: 'todos', id: 1 }])

    await expect(
      lifecycle.rebase(draftId, {
        acceptConflicts: async () => {
          await app.call('renameTodo', { id: 1, title: 'canonical-v2' })
          probe.bump([{ table: 'todos', id: 1 }])
          return true
        },
      }),
    ).rejects.toThrow('canonical version changed during rebase')

    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
    await expect(lifecycle.detectConflict(draftId)).resolves.toMatchObject({
      staleBase: true,
    })
  })

  test('rebase distinguishes Date version tokens changed by conflict acceptance', async () => {
    let current = new Date('2026-01-01T00:00:00.000Z')
    const probe: VersionProbe = {
      async current() {
        return new Date(current)
      },
      isNewerThan(candidate, base) {
        return (
          new Date(candidate as string | number | Date).getTime() >
          new Date(base as string | number | Date).getTime()
        )
      },
      async cellsWrittenSince(_base, cells) {
        return cells
      },
    }
    const lifecycle = createDraftLifecycle(app, { versionProbe: probe })
    const draftId = await lifecycle.open(await probe.current())
    await lifecycle.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'draft-title' } }])
    current = new Date('2026-01-01T00:00:01.000Z')

    await expect(
      lifecycle.rebase(draftId, {
        acceptConflicts: () => {
          current = new Date('2026-01-01T00:00:02.000Z')
          return true
        },
      }),
    ).rejects.toThrow('canonical version changed during rebase')

    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  /** Persisted varchar(n) identities cast back to their canonical row during publish. */
  test('publishes drafts whose persisted identity is a length-qualified varchar', async () => {
    await db.execute(`INSERT INTO varchar_items (id, title) VALUES ('item-0001', 'canonical')`)
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'renameVarcharItem', args: { id: 'item-0001', title: 'draft' } },
    ])

    await lifecycle.publish(draftId)

    expect((await db.select().from(varcharItems))[0]?.title).toBe('draft')
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
    expect((migration as any).rows[0].version).toBe(8)

    await restartedProcess.publish(draftId)
    const { result: canonical } = await app.call('listTodos', {})
    expect((canonical as { id: number }[]).some((row) => row.id === 3)).toBe(true)
    await expect(restartedProcess.getLog(draftId)).rejects.toThrow('unknown draft')
  })
})

describe('draft lifecycle — owned discovery and atomic creation', () => {
  test('opens a discoverable, materialized initial command batch in one operation', async () => {
    const lifecycle = createDraftLifecycle(app)
    const command = {
      id: 'initial-command',
      path: 'addTodo',
      args: { id: 3, title: 'atomic cherry' },
    }

    const { draftId, results } = await lifecycle.openWithCommands(0, [command], {
      lookupKey: 'artifact:atomic-success',
      summary: { title: 'Atomic draft', commandCount: 1 },
    })

    expect(results.map((result) => result.id)).toEqual(['initial-command'])
    expect(await lifecycle.getLog(draftId)).toEqual([command])
    expect(await lifecycle.inspect(draftId)).toContainEqual(
      expect.objectContaining({ draftId, table: 'todos', operation: 'insert' }),
    )
    expect(await lifecycle.findOwnedByLookupKey('artifact:atomic-success')).toMatchObject({
      draftId,
      summary: { title: 'Atomic draft', commandCount: 1 },
    })
  })

  test('rolls back a failed atomic open before the draft becomes discoverable', async () => {
    const lifecycle = createDraftLifecycle(app)

    await expect(
      lifecycle.openWithCommands(
        0,
        [
          { path: 'addTodo', args: { id: 3, title: 'must roll back' } },
          { path: 'boom', args: {} },
        ],
        {
          lookupKey: 'artifact:atomic-failure',
          summary: { title: 'Must not survive' },
        },
      ),
    ).rejects.toThrow('command boom')

    expect(await lifecycle.findOwnedByLookupKey('artifact:atomic-failure')).toBeUndefined()
    expect(await lifecycle.listOwned()).toEqual([])
    expect(await readDraftArtifactCounts()).toEqual({
      drafts: 0,
      commands: 0,
      tables: 0,
      changes: 0,
    })
  })

  test('rejects an empty atomic-open batch without creating a draft', async () => {
    const lifecycle = createDraftLifecycle(app)

    await expect(lifecycle.openWithCommands(0, [])).rejects.toThrow('non-empty batch')
    expect(await lifecycle.listOwned()).toEqual([])
  })

  test('get-or-open reuses the existing owned key without executing a subsequent batch', async () => {
    const lifecycle = createDraftLifecycle(app)
    const lookupKey = 'artifact:existing-draft'
    const first = await lifecycle.getOrOpenWithCommands(
      0,
      [{ id: 'first', path: 'addTodo', args: { id: 3, title: 'created' } }],
      { lookupKey },
    )
    const second = await lifecycle.getOrOpenWithCommands(
      0,
      [{ id: 'second', path: 'addTodo', args: { id: 4, title: 'must not run' } }],
      { lookupKey },
    )

    expect({ created: first.created, resultIds: first.results.map(({ id }) => id) }).toEqual({
      created: true,
      resultIds: ['first'],
    })
    expect(second).toEqual({ created: false, draftId: first.draftId, results: [] })
    expect(await lifecycle.getLog(first.draftId)).toEqual([
      { id: 'first', path: 'addTodo', args: { id: 3, title: 'created' } },
    ])
    expect(await lifecycle.inspect(first.draftId)).toHaveLength(1)
  })

  test('lists stable created-order pages after lifecycle recreation', async () => {
    const lifecycle = createOwnedDraftLifecycle()
    const aliceOldest = await lifecycle.open({ sequence: 1 }, { context: { owner: 'alice' } })
    const bob = await lifecycle.open({ sequence: 2 }, { context: { owner: 'bob' } })
    const aliceTieA = await lifecycle.open({ sequence: 3 }, { context: { owner: 'alice' } })
    const aliceTieB = await lifecycle.open({ sequence: 4 }, { context: { owner: 'alice' } })
    const aliceNewest = await lifecycle.open({ sequence: 5 }, { context: { owner: 'alice' } })

    await db.execute(sql`UPDATE wystack_drafts SET created_at =
      CASE draft_id
        WHEN ${aliceOldest} THEN '2026-08-01T00:00:00.000Z'::timestamptz
        WHEN ${bob} THEN '2026-08-02T00:00:00.000Z'::timestamptz
        WHEN ${aliceTieA} THEN '2026-08-03T00:00:00.000Z'::timestamptz
        WHEN ${aliceTieB} THEN '2026-08-03T00:00:00.000Z'::timestamptz
        WHEN ${aliceNewest} THEN '2026-08-04T00:00:00.000Z'::timestamptz
        ELSE updated_at
      END`)

    const restarted = createOwnedDraftLifecycle()
    const tieOrder = [aliceTieA, aliceTieB].sort().reverse()
    const expectedIds = [aliceNewest, ...tieOrder, aliceOldest]
    const firstPage = await restarted.listOwned({ context: { owner: 'alice' }, limit: 2 })
    await restarted.append(
      aliceOldest,
      [{ path: 'addTodo', args: { id: 90, title: 'moves updated_at only' } }],
      { context: { owner: 'alice' }, summary: { title: 'oldest changed' } },
    )
    const secondPage = await restarted.listOwned({
      context: { owner: 'alice' },
      limit: 2,
      cursor: firstPage.at(-1)?.cursor,
    })

    expect([...firstPage, ...secondPage].map((draft) => draft.draftId)).toEqual(expectedIds)
    expect(firstPage[0]?.cursor.draftId).toBe(aliceNewest)
    expect(firstPage[0]?.cursor.createdAt).toBe(firstPage[0]?.createdAt)
    expect(firstPage[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  })

  test('applies safe default and maximum owner-list page bounds', async () => {
    const lifecycle = createOwnedDraftLifecycle()
    for (let sequence = 0; sequence <= DEFAULT_OWNED_DRAFT_PAGE_SIZE; sequence += 1) {
      await lifecycle.open({ sequence }, { context: { owner: 'alice' } })
    }

    expect(await lifecycle.listOwned({ context: { owner: 'alice' } })).toHaveLength(
      DEFAULT_OWNED_DRAFT_PAGE_SIZE,
    )
    await expect(
      lifecycle.listOwned({
        context: { owner: 'alice' },
        limit: MAX_OWNED_DRAFT_PAGE_SIZE + 1,
      }),
    ).rejects.toThrow(`must not exceed ${MAX_OWNED_DRAFT_PAGE_SIZE}`)
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(lifecycle.listOwned({ context: { owner: 'alice' }, limit })).rejects.toThrow(
        'positive safe integer',
      )
    }
  })

  test('persists snapshotted lookup metadata across append and lifecycle recreation', async () => {
    const lifecycle = createOwnedDraftLifecycle()
    const initialSummary = { title: 'initial', nested: { sequence: 1 } }
    const opening = lifecycle.open(0, {
      context: { owner: 'alice' },
      lookupKey: 'artifact:file-1',
      summary: initialSummary,
    })
    initialSummary.title = 'mutated after open'
    const draftId = await opening
    expect(
      await lifecycle.findOwnedByLookupKey('artifact:file-1', {
        context: { owner: 'alice' },
      }),
    ).toMatchObject({ summary: { title: 'initial', nested: { sequence: 1 } } })

    const nextSummary = { title: 'after append', nested: { sequence: 2 } }
    const appending = lifecycle.append(
      draftId,
      [{ path: 'addTodo', args: { id: 91, title: 'metadata' } }],
      { context: { owner: 'alice' }, summary: nextSummary },
    )
    nextSummary.nested.sequence = 999
    await appending

    const restarted = createOwnedDraftLifecycle()
    expect(
      await restarted.findOwnedByLookupKey('artifact:file-1', {
        context: { owner: 'alice' },
      }),
    ).toMatchObject({
      draftId,
      lookupKey: 'artifact:file-1',
      summary: { title: 'after append', nested: { sequence: 2 } },
    })
  })

  test('a failed append rolls its summary replacement back with the command batch', async () => {
    const lifecycle = createOwnedDraftLifecycle()
    const context = { owner: 'alice' }
    const draftId = await lifecycle.open(0, {
      context,
      lookupKey: 'artifact:file-2',
      summary: { state: 'initial' },
    })

    await expect(
      lifecycle.append(
        draftId,
        [
          { path: 'addTodo', args: { id: 92, title: 'rolled back' } },
          { path: 'boom', args: {} },
        ],
        { context, summary: { state: 'must-not-commit' } },
      ),
    ).rejects.toThrow('command boom')
    expect(await lifecycle.findOwnedByLookupKey('artifact:file-2', { context })).toMatchObject({
      summary: { state: 'initial' },
    })
  })

  test('omitting an append summary preserves it while explicit null clears it', async () => {
    const lifecycle = createOwnedDraftLifecycle()
    const context = { owner: 'alice' }
    const draftId = await lifecycle.open(0, {
      context,
      lookupKey: 'artifact:file-3',
      summary: { state: 'initial' },
    })

    await lifecycle.append(
      draftId,
      [{ path: 'addTodo', args: { id: 93, title: 'keeps summary' } }],
      { context },
    )
    expect(await lifecycle.findOwnedByLookupKey('artifact:file-3', { context })).toMatchObject({
      summary: { state: 'initial' },
    })

    await lifecycle.append(draftId, [], { context, summary: null })
    expect(await lifecycle.findOwnedByLookupKey('artifact:file-3', { context })).toMatchObject({
      summary: null,
    })
  })

  test('validates lookup keys at open and discovery entrypoints', async () => {
    const lifecycle = createOwnedDraftLifecycle()
    await expect(
      lifecycle.open(0, {
        context: { owner: 'alice' },
        lookupKey: '界'.repeat(171),
      }),
    ).rejects.toThrow('512 UTF-8 bytes')
    await expect(
      lifecycle.findOwnedByLookupKey('', { context: { owner: 'alice' } }),
    ).rejects.toThrow('non-empty text')
    expect(await lifecycle.listOwned({ context: { owner: 'alice' } })).toEqual([])
  })

  test('bounds discovery summaries by their serialized UTF-8 size at every open ingress', async () => {
    const lifecycle = createDraftLifecycle(app)
    const exactLimit = 'x'.repeat(MAX_DRAFT_SUMMARY_BYTES - 2)
    const acceptedId = await lifecycle.open(0, {
      lookupKey: 'summary:exact-limit',
      summary: exactLimit,
    })

    await expect(
      lifecycle.open(0, { summary: 'x'.repeat(MAX_DRAFT_SUMMARY_BYTES - 1) }),
    ).rejects.toThrow(`${MAX_DRAFT_SUMMARY_BYTES} serialized UTF-8 bytes`)
    await expect(
      lifecycle.openWithCommands(
        0,
        [{ path: 'addTodo', args: { id: 3, title: 'must not materialize' } }],
        {
          lookupKey: 'summary:oversized-atomic',
          summary: 'x'.repeat(MAX_DRAFT_SUMMARY_BYTES - 1),
        },
      ),
    ).rejects.toThrow(`${MAX_DRAFT_SUMMARY_BYTES} serialized UTF-8 bytes`)

    expect(await lifecycle.findOwnedByLookupKey('summary:exact-limit')).toMatchObject({
      draftId: acceptedId,
      summary: exactLimit,
    })
    expect(await lifecycle.findOwnedByLookupKey('summary:oversized-atomic')).toBeUndefined()
    expect((await lifecycle.listOwned()).map((draft) => draft.draftId)).toEqual([acceptedId])
  })

  test('rejects over-deep summary replacements before append or fork writes', async () => {
    const lifecycle = createDraftLifecycle(app)
    const sourceId = await lifecycle.open(0, {
      lookupKey: 'summary:depth-source',
      summary: { state: 'initial' },
    })
    const exactDepth = nestedSummary(MAX_DRAFT_SUMMARY_DEPTH)
    const exactDepthId = await lifecycle.open(0, { summary: exactDepth })
    const overDepth: DraftSummary = { child: exactDepth }

    await expect(lifecycle.append(sourceId, [], { summary: overDepth })).rejects.toThrow(
      `${MAX_DRAFT_SUMMARY_DEPTH} nested containers`,
    )
    await expect(
      lifecycle.forkAndDiscard(sourceId, 1, (commands) => ({
        commands,
        summary: overDepth,
      })),
    ).rejects.toThrow(`${MAX_DRAFT_SUMMARY_DEPTH} nested containers`)

    expect(await lifecycle.findOwnedByLookupKey('summary:depth-source')).toMatchObject({
      draftId: sourceId,
      summary: { state: 'initial' },
    })
    expect((await lifecycle.listOwned()).map((draft) => draft.draftId)).toContain(exactDepthId)
  })

  test('default custody follows stable principal identity, not mutable profile fields', async () => {
    const lifecycle = createProductionDraftLifecycle(app, {
      authorizeGlobalDraft: () => true,
    })
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
      await createProductionDraftLifecycle(app, {
        authorizeGlobalDraft: () => true,
      }).getLog(draftId, {
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
})

describe('draft lifecycle — append and publish', () => {
  test('canonical-only reads are not treated as draft writes during publish', async () => {
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
    const draftRows = await app.system.createTracked().withDraft(draftId).from(schema.todos).all()
    const byId = Object.fromEntries(draftRows.map((r) => [r['id'], r]))
    expect(byId[1]['title']).toBe('APPLE')
    expect(byId[3]['title']).toBe('cherry')
  })

  test('publish verifies intent and applies reviewed changes atomically', async () => {
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
    const overlay = await db.execute(
      `SELECT * FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((overlay as any).rows).toHaveLength(0)
  })

  test('atomic publish: derived-change sweep failure rolls back the canonical commit', async () => {
    // Verification, reviewed writes, and the derived sweep share ONE transaction. If the sweep fails
    // (e.g. the central table is missing), the outer tx rolls back BOTH the
    // canonical reviewed changes AND the sweep — no "canonical committed but
    // derived changes still present" state. The draft stays live and publish is retryable.
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    // Drop the central derived-change table so the sweep throws inside the outer tx.
    await db.execute(`DROP TABLE wystack_draft_row_changes`)

    // publish must THROW (the outer tx rolled back), NOT silently succeed.
    await expect(lc.publish(draftId)).rejects.toThrow()

    // Canonical MUST NOT have the row — the reviewed write rolled back with the sweep.
    // Check both the count (fixture rows only) and that id=3 is absent.
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
    expect((canonical as { id: number }[]).find((r) => r.id === 3)).toBeUndefined()

    // Durable metadata and log are still live — the caller can retry or discard.
    expect(await lc.getLog(draftId)).toHaveLength(1)
  })

  test('atomic publish: reviewed changes and sweep commit together', async () => {
    // Exactly-once publish requires canonical changes and the derived sweep to
    // be inseparable. With one outer transaction, the only observable states are:
    //   - tx committed → canonical has the row AND derived changes are swept
    //   - tx rolled back → canonical is clean AND derived changes remain
    // The "canonical committed but derived changes not swept" state cannot occur.
    //
    // Test approach: open, append, then verify that a SUCCESSFUL publish leaves
    // canonical written AND derived changes swept in the same observable snapshot — we
    // cannot observe mid-transaction state, but we can verify the end-to-end
    // invariant and check that durable metadata disappears with the commit.
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const result = await lc.publish(draftId)
    expect(result.mode).toBe('commit')
    expect(result.tablesWritten.has('todos')).toBe(true)

    // Canonical reflects the reviewed change.
    const { result: canonical } = await app.call('listTodos', {})
    const byId = Object.fromEntries((canonical as { id: number }[]).map((r) => [r.id, r]))
    expect(byId[3]).toBeDefined()

    // Derived changes swept in the SAME commit: no orphan rows exist post-publish.
    const overlay = await db.execute(
      `SELECT * FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((overlay as any).rows).toHaveLength(0)

    // Registry entry removed post-commit — a second publish cannot apply twice.
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
      {
        path: 'removeTodo',
        args: { id: 3 },
        compactionKey: 'todo:3',
        kind: 'delete',
      },
    ])
    expect(await lc.getLog(draftId)).toHaveLength(0)

    await lc.publish(draftId)
    // Canonical unchanged — the create+delete cancelled before publish.
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
  })
})

describe('draft lifecycle — reviewed changes are the publication authority', () => {
  test('a newer read-modify-write result is reported as drift and preserves the draft', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    // Two add_to_dashboard read-modify-write commands inside the draft. The
    // overlay's stored `items` reflects the merge against the canonical value
    // AT APPEND TIME ('a' → 'a,x' → 'a,x,y').
    await lc.append(draftId, [
      { path: 'addToDashboard', args: { dashboardId: 1, item: 'x' } },
      { path: 'addToDashboard', args: { dashboardId: 1, item: 'y' } },
    ])

    // A concurrent writer changes the command's input after review. Publish
    // must not silently replace the reviewed result with a new merge.
    await db.execute(`UPDATE dashboards SET items = 'a,z' WHERE id = 1`)

    // The ordered intent remains available for application review and repair.
    expect((await lc.getLog(draftId)).map((c) => c.path)).toEqual([
      'addToDashboard',
      'addToDashboard',
    ])

    await expect(lc.publish(draftId)).rejects.toMatchObject({
      differences: [{ table: 'dashboards', id: 1, reason: 'value' }],
    })

    const res = await db.execute(`SELECT items FROM dashboards WHERE id = 1`)
    // oxlint-disable-next-line typescript/no-explicit-any
    const items = (res as any).rows[0].items as string
    expect(items).toBe('a,z')
    expect(await lc.getLog(draftId)).toHaveLength(2)
  })

  test('a changed reviewed field anchor is reported even when the proposal is unchanged', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'renameTodo', args: { id: 1, title: 'reviewed title' } },
    ])

    await db.execute(`UPDATE todos SET title = 'external title' WHERE id = 1`)

    await expect(lifecycle.publish(draftId)).rejects.toMatchObject({
      differences: [{ table: 'todos', id: 1, reason: 'anchor' }],
    })
    const { result } = await app.call('listTodos', {})
    expect((result as { id: number; title: string }[]).find((row) => row.id === 1)?.title).toBe(
      'external title',
    )
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  test('a changed unrevisioned row is not deleted behind the reviewer', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'removeTodo', args: { id: 1 } }])

    await db.execute(`UPDATE todos SET title = 'external title' WHERE id = 1`)

    await expect(lifecycle.publish(draftId)).rejects.toMatchObject({
      differences: [{ table: 'todos', id: 1, reason: 'anchor' }],
    })
    const { result } = await app.call('listTodos', {})
    expect(result).toContainEqual({ id: 1, title: 'external title', done: false })
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  test('a predicate phantom is reported instead of changing an unreviewed row', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'finishOpenTodos', args: {} }])

    await app.call('addTodo', { id: 3, title: 'new canonical row' })

    await expect(lifecycle.publish(draftId)).rejects.toMatchObject({
      differences: [{ table: 'todos', id: 3, reason: 'target' }],
    })
    const { result } = await app.call('listTodos', {})
    expect((result as { id: number; done: boolean }[]).find((row) => row.id === 3)?.done).toBe(
      false,
    )
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  test('a changed read dependency cannot alter the reviewed write output', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'addTodoUsingSetting', args: { id: 3 } }])

    await db.execute(`UPDATE settings SET prefix = 'new-setting' WHERE id = 1`)

    await expect(lifecycle.publish(draftId)).rejects.toBeInstanceOf(DraftPublishDriftError)
    const { result } = await app.call('listTodos', {})
    expect((result as { id: number }[]).some((row) => row.id === 3)).toBe(false)
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  test('publishes a reviewed JSON null without converting it to SQL NULL', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'setDocumentPayload', args: { id: 1, payload: null } },
    ])

    await lifecycle.publish(draftId)

    const result = await db.execute(
      `SELECT payload IS NULL AS sql_null, payload = 'null'::jsonb AS json_null FROM documents WHERE id = 1`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((result as any).rows[0]).toEqual({
      sql_null: false,
      json_null: true,
    })
  })

  test('orders parent and child changes for immediate foreign keys', async () => {
    const lifecycle = createDraftLifecycle(app)
    const insertDraft = await lifecycle.open(0)
    await lifecycle.append(insertDraft, [
      { path: 'addFamily', args: { parentId: 20, childId: 21 } },
    ])

    expect((await lifecycle.inspect(insertDraft)).map((row) => row.table)).toEqual([
      'aChildren',
      'zParents',
    ])
    await lifecycle.publish(insertDraft)
    const inserted = await db.execute(
      `SELECT c.id FROM "aChildren" c JOIN "zParents" p ON p.id = c."parentId" WHERE c.id = 21`,
    )
    expect((inserted as { rows: unknown[] }).rows).toHaveLength(1)

    const deleteDraft = await lifecycle.open(0)
    await lifecycle.append(deleteDraft, [
      { path: 'removeFamily', args: { parentId: 10, childId: 11 } },
    ])
    await lifecycle.publish(deleteDraft)
    const removed = await db.execute(
      `SELECT (SELECT count(*) FROM "zParents" WHERE id = 10) AS parents,
              (SELECT count(*) FROM "aChildren" WHERE id = 11) AS children`,
    )
    expect((removed as { rows: unknown[] }).rows[0]).toEqual({ parents: 0, children: 0 })
  })

  test('releases an old unique-key reference before updating its parent', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      {
        path: 'retargetAndRenameCode',
        args: {
          childId: 1,
          parentId: 1,
          nextParentCode: 'stable',
          nextCode: 'renamed',
        },
      },
    ])

    expect((await lifecycle.inspect(draftId)).map((row) => row.table)).toEqual([
      'aCodeParents',
      'zCodeChildren',
    ])
    await lifecycle.publish(draftId)

    const result = await db.execute(
      `SELECT p.code, c."parentCode" AS parent_code
       FROM "aCodeParents" p CROSS JOIN "zCodeChildren" c
       WHERE p.id = 1 AND c.id = 1`,
    )
    expect((result as { rows: unknown[] }).rows[0]).toEqual({
      code: 'renamed',
      parent_code: 'stable',
    })
  })

  test('phases parent and child replacements around immediate foreign keys', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'replaceCodeFamily', args: { parentId: 1, childId: 1, code: 'old' } },
    ])

    expect((await lifecycle.inspect(draftId)).map((row) => row.operation)).toEqual([
      'insert',
      'insert',
    ])
    await lifecycle.publish(draftId)

    const result = await db.execute(
      `SELECT c.id FROM "zCodeChildren" c
       JOIN "aCodeParents" p ON p.code = c."parentCode" WHERE c.id = 1`,
    )
    expect((result as { rows: unknown[] }).rows).toHaveLength(1)
  })

  test('orders self-referencing rows rather than relying on table order', async () => {
    const lifecycle = createDraftLifecycle(app)
    const insertDraft = await lifecycle.open(0)
    await lifecycle.append(insertDraft, [
      { path: 'addTreePair', args: { parentId: 21, childId: 20 } },
    ])

    expect((await lifecycle.inspect(insertDraft)).map((row) => row.rowKey)).toEqual([
      { type: 'integer', value: 20 },
      { type: 'integer', value: 21 },
    ])
    await lifecycle.publish(insertDraft)

    const deleteDraft = await lifecycle.open(0)
    await lifecycle.append(deleteDraft, [
      { path: 'removeTreePair', args: { parentId: 10, childId: 11 } },
    ])
    await lifecycle.publish(deleteDraft)
    const remaining = await db.execute(`SELECT id FROM "treeNodes" WHERE id IN (10, 11)`)
    expect((remaining as { rows: unknown[] }).rows).toEqual([])
  })

  test('matches timestamp foreign keys by their canonical instant', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    const token = new Date('2026-08-28T12:34:56.789Z')
    await lifecycle.append(draftId, [
      { path: 'addTimedFamily', args: { parentId: 1, childId: 2, token } },
    ])

    await lifecycle.publish(draftId)

    const joined = await db.execute(
      `SELECT c.id FROM "aTimedChildren" c
       JOIN "zTimedParents" p ON p.token = c."parentToken" WHERE c.id = 2`,
    )
    expect((joined as { rows: unknown[] }).rows).toHaveLength(1)
  })

  test('a mid-log failure at publish rolls the whole batch back (atomic)', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    // Publish-time resolve injects a command that violates the NOT NULL title.
    // The failed verification replay rolls back before canonical apply.
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
    // derived rows and no canonical effect.
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

    // Recover via discard: derived changes cleared, canonical untouched, draft forgotten.
    await lc.discard(draftId)
    const overlay = await db.execute(
      `SELECT * FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((overlay as any).rows).toHaveLength(0)
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
  })
})

describe('draft lifecycle — row-local revision conflicts', () => {
  test('publishing one draft advances the revision so a stale sibling cannot overwrite it', async () => {
    const lifecycle = createDraftLifecycle(app)
    const first = await lifecycle.open(0)
    const second = await lifecycle.open(0)
    await lifecycle.append(first, [
      { path: 'renameVersionedTodo', args: { id: 1, title: 'first draft' } },
    ])
    await lifecycle.append(second, [
      { path: 'renameVersionedTodo', args: { id: 1, title: 'second draft' } },
    ])

    await lifecycle.publish(first)
    await expect(lifecycle.publish(second)).rejects.toMatchObject({
      conflicts: [{ table: 'versionedTodos', id: 1, reason: 'revision' }],
    })

    const { result } = await app.call('listVersionedTodos', {})
    expect(result).toEqual([{ id: 1, title: 'first draft', revision: 2 }])
    expect(await lifecycle.getLog(second)).toHaveLength(1)
  })

  test('publish rejects a concurrent revision change and leaves the draft retryable', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'renameVersionedTodo', args: { id: 1, title: 'draft title' } },
    ])
    await db.execute(`UPDATE "versionedTodos" SET title = 'external', revision = 2 WHERE id = 1`)

    let conflict: unknown
    try {
      await lifecycle.publish(draftId)
    } catch (error) {
      conflict = error
    }

    expect(conflict).toBeInstanceOf(DraftConflictError)
    expect((conflict as DraftConflictError).conflicts).toEqual([
      { table: 'versionedTodos', id: 1, reason: 'revision' },
    ])
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
    const { result } = await app.call('listVersionedTodos', {})
    expect(result).toEqual([{ id: 1, title: 'external', revision: 2 }])
  })

  /**
   * The touched-table descriptor is a snapshot from the last append. If the
   * table gains a revision column afterwards, publish must not silently skip
   * the compare-and-swap that snapshot cannot express: a canonical write
   * through the tracker leaves a revision ledger row, and that alone is enough
   * to fail closed until a rebase rebuilds the descriptor.
   */
  test('publish fails closed when a touched table was revisioned after its descriptor was stored', async () => {
    // The stored descriptor is the table as it was at append time. Clearing its
    // revision column models a table that gained .revision() afterwards: the
    // compare-and-swap then has nothing to check, and a plain canonical update
    // (which bumps the row inline and leaves no other trace) would be
    // overwritten. Publish must roll back with a revision conflict instead.
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'renameVersionedTodo', args: { id: 1, title: 'draft title' } },
    ])
    await db.execute(
      `UPDATE wystack_draft_tables SET revision_column = NULL WHERE draft_id = '${draftId}' AND table_name = 'versionedTodos'`,
    )
    await refreshStoredDraftIntegrity(db, draftId)
    await app.call('renameVersionedTodo', { id: 1, title: 'external' })

    await expect(lifecycle.publish(draftId)).rejects.toMatchObject({
      conflicts: [{ table: 'versionedTodos', id: 1, reason: 'revision' }],
    })
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
    const { result } = await app.call('listVersionedTodos', {})
    expect(result).toEqual([{ id: 1, title: 'external', revision: 2 }])
  })

  test('a leftover row-revision ledger entry does not block publishing an unrevisioned table', async () => {
    // Nothing deletes ledger rows when a table drops .revision(). They are not
    // evidence of drift on their own; only a descriptor that disagrees with the
    // live schema is.
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'draft title' } }])
    await db.execute(
      `INSERT INTO wystack_row_revisions (table_key, tenant_key_text, row_key_text, revision) VALUES ('todos', '', '1', 2)`,
    )

    await lifecycle.publish(draftId)
    const { result } = await app.call('listTodos', {})
    expect(
      (result as Array<{ id: number; title: string }>).find((row) => row.id === 1)?.title,
    ).toBe('draft title')
  })

  test('delete and reinsert creates a new row incarnation that conflicts with a stale draft', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'renameVersionedTodo', args: { id: 1, title: 'draft title' } },
    ])

    await app.call('removeVersionedTodo', { id: 1 })
    await app.call('addVersionedTodo', { id: 1, title: 'replacement' })

    const { result: replacement } = await app.call('listVersionedTodos', {})
    expect(replacement).toEqual([{ id: 1, title: 'replacement', revision: 2 }])
    await expect(lifecycle.publish(draftId)).rejects.toMatchObject({
      conflicts: [{ table: 'versionedTodos', id: 1, reason: 'revision' }],
    })

    const { result: afterConflict } = await app.call('listVersionedTodos', {})
    expect(afterConflict).toEqual([{ id: 1, title: 'replacement', revision: 2 }])
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  test('publishing a delete preserves the next incarnation token', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'removeVersionedTodo', args: { id: 1 } }])

    await lifecycle.publish(draftId)
    await app.call('addVersionedTodo', { id: 1, title: 'replacement' })

    const { result } = await app.call('listVersionedTodos', {})
    expect(result).toEqual([{ id: 1, title: 'replacement', revision: 2 }])
  })

  test('replacement revisions match between the overlay and published replay', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'removeVersionedTodo', args: { id: 1 } },
      { path: 'addVersionedTodo', args: { id: 1, title: 'replacement' } },
      { path: 'renameVersionedTodo', args: { id: 1, title: 'final title' } },
    ])

    const effective = await app.system
      .createTracked()
      .withDraft(draftId)
      .from(schema.versionedTodos)
      .all()
    expect(effective).toEqual([{ id: 1, title: 'final title', revision: 3 }])

    await lifecycle.publish(draftId)
    const { result: published } = await app.call('listVersionedTodos', {})
    expect(published).toEqual(effective)
  })

  test('ordered keyed updates preserve the effective revision when published', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      {
        path: 'renameVersionedTodo',
        args: { id: 1, title: 'first title' },
        compactionKey: 'versioned-todo:1',
        kind: 'update',
      },
      {
        path: 'renameVersionedTodo',
        args: { id: 1, title: 'final title' },
        compactionKey: 'versioned-todo:1',
        kind: 'update',
      },
    ])

    const effective = await app.system
      .createTracked()
      .withDraft(draftId)
      .from(schema.versionedTodos)
      .all()
    expect(effective).toEqual([{ id: 1, title: 'final title', revision: 3 }])
    expect(await lifecycle.getLog(draftId)).toHaveLength(2)

    await lifecycle.publish(draftId)
    const { result: published } = await app.call('listVersionedTodos', {})
    expect(published).toEqual(effective)
  })

  test('reviewed publication fails closed when a schema change leaves no writable fields', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'renameVersionedTodo', args: { id: 1, title: 'draft title' } },
    ])

    // Model a deployment that removed the only user-managed field after review.
    // The reviewed revision still needs to advance, but replaying an empty patch
    // cannot do that and must report drift instead of retrying forever.
    const changedSchema = defineSchema({
      versionedTodos: table({ id: int.primaryKey(), revision: int })
        .revision('revision')
        .draftable(),
    })
    const liveTables = new Map([['versionedTodos', changedSchema.versionedTodos]])

    await expect(
      applyReviewedChanges(app.system.createTracked(), draftId, liveTables),
    ).rejects.toMatchObject({
      differences: [{ table: 'versionedTodos', id: 1, reason: 'anchor' }],
    })
  })

  test('an absent reused identity keeps its planned token unless the ledger changes', async () => {
    await app.call('removeVersionedTodo', { id: 1 })
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'addVersionedTodo', args: { id: 1, title: 'draft replacement' } },
    ])

    const effective = await app.system
      .createTracked()
      .withDraft(draftId)
      .from(schema.versionedTodos)
      .all()
    expect(effective).toEqual([{ id: 1, title: 'draft replacement', revision: 2 }])

    await app.call('addVersionedTodo', {
      id: 1,
      title: 'concurrent replacement',
    })
    await app.call('removeVersionedTodo', { id: 1 })
    await expect(lifecycle.publish(draftId)).rejects.toMatchObject({
      conflicts: [{ table: 'versionedTodos', id: 1, reason: 'revision' }],
    })
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  test('a missing revision reservation fails closed and leaves the draft intact', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'renameVersionedTodo', args: { id: 1, title: 'draft title' } },
    ])
    await db.execute(`DELETE FROM wystack_row_revisions WHERE table_key = 'versionedTodos'`)

    await expect(lifecycle.publish(draftId)).rejects.toMatchObject({
      conflicts: [{ table: 'versionedTodos', id: 1, reason: 'revision' }],
    })
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
  })

  test('graph validation failure rolls replay back with the draft intact', async () => {
    const lifecycle = createDraftLifecycle(app, {
      validateGraph({ phase }) {
        if (phase === 'published') throw new Error('invalid published graph')
      },
    })
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'draft title' } }])

    await expect(lifecycle.publish(draftId)).rejects.toThrow('invalid published graph')
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
    const { result } = await app.call('listTodos', {})
    expect((result as { id: number; title: string }[]).find((row) => row.id === 1)?.title).toBe(
      'apple',
    )
  })

  test('graph validators receive a read-only database capability', async () => {
    const phases: string[] = []
    const lifecycle = createDraftLifecycle(app, {
      async validateGraph({ phase, db: validationDb }) {
        phases.push(phase)
        expect(await validationDb.from(schema.todos).where(eq('id', 1)).first()).not.toBeNull()

        const tracker = validationDb as unknown as Record<string, unknown>
        expect(tracker['into']).toBeUndefined()
        expect(tracker['raw']).toBeUndefined()
        expect(tracker['transaction']).toBeUndefined()
        expect(tracker['withDraft']).toBeUndefined()
        expect(tracker['withTenant']).toBeUndefined()

        const builder = validationDb.from(schema.todos) as unknown as Record<string, unknown>
        expect(builder['update']).toBeUndefined()
        expect(builder['delete']).toBeUndefined()
      },
    })
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'draft title' } }])

    await lifecycle.publish(draftId)

    expect(phases).toEqual(['effective', 'published'])
    const { result } = await app.call('listTodos', {})
    expect(result).toContainEqual(expect.objectContaining({ id: 1, title: 'draft title' }))
  })
})

describe('draft lifecycle — resolve(log) cannot bypass reviewed changes', () => {
  test('a resolved value that changes the reviewed result is reported as drift', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    // The appended command carries a PLACEHOLDER title; resolve binds it.
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: '<<late>>' } }])

    let sawLog: Command[] = []
    await expect(
      lc.publish(draftId, (logToBind) => {
        sawLog = logToBind
        return logToBind.map((c) =>
          c.path === 'addTodo' ? { ...c, args: { ...(c.args as object), title: 'BOUND' } } : c,
        )
      }),
    ).rejects.toBeInstanceOf(DraftPublishDriftError)

    expect(sawLog).toHaveLength(1) // hook saw the ordered log
    const res = await db.execute(`SELECT title FROM todos WHERE id = 3`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((res as any).rows).toHaveLength(0)
    expect(await lc.getLog(draftId)).toHaveLength(1)
  })
})

describe('draft lifecycle — detectConflict (generic, artifact-agnostic)', () => {
  test('no probe ⇒ detection opts out (no conflict reported)', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'X' } }])
    expect(await lc.detectConflict(draftId)).toEqual({
      staleBase: false,
      overlappingCells: [],
    })
  })

  test('probe present but canonical unchanged ⇒ clean (the common publish case)', async () => {
    const probe = makeProbe()
    const lc = createDraftLifecycle(app, { versionProbe: probe })
    const base = await probe.current()
    const draftId = await lc.open(base)
    await lc.append(draftId, [{ path: 'renameTodo', args: { id: 1, title: 'DRAFT-1' } }])
    // No canonical bump between open and detect — nothing moved.
    expect(await lc.detectConflict(draftId)).toEqual({
      staleBase: false,
      overlappingCells: [],
    })
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

    // Canonical untouched, derived changes cleared, draft forgotten.
    const { result: canonical } = await app.call('listTodos', {})
    expect(canonical as unknown[]).toHaveLength(2)
    const overlay = await db.execute(
      `SELECT * FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((overlay as any).rows).toHaveLength(0)
    await expect(lc.detectConflict(draftId)).rejects.toThrow('unknown draft')
  })
})

describe('draft lifecycle — a command that cannot be snapshotted', () => {
  test('a non-JSON command fails before its write, leaving the draft untouched', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    await expect(
      lc.append(draftId, [
        {
          path: 'addTodoWithMeta',
          args: { id: 3, title: 'cherry', meta: { onDone: () => {} } },
        },
      ]),
    ).rejects.toThrow('must be JSON-compatible')

    // Neither half of the draft moved: no command logged, no overlay row.
    expect(await lc.getLog(draftId)).toHaveLength(0)
    const overlay = await db.execute(
      `SELECT * FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((overlay as any).rows).toHaveLength(0)

    // And the draft is still usable — this was a rejected command, not a
    // poisoned draft.
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    expect(await lc.getLog(draftId)).toHaveLength(1)
  })

  test('normalizes undefined object properties before execution and persistence', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)

    await lifecycle.append(draftId, [
      {
        path: 'addTodoWithMeta',
        args: { id: 3, title: 'cherry', meta: { flag: undefined } },
      },
    ])

    expect(await lifecycle.getLog(draftId)).toEqual([
      { path: 'addTodoWithMeta', args: { id: 3, title: 'cherry', meta: {} } },
    ])
    await lifecycle.publish(draftId)
    const { result } = await app.call('listTodos', {})
    expect((result as Array<{ id: number }>).some((row) => row.id === 3)).toBe(true)
  })

  test('canonicalizes Date arguments before persistence and lifecycle reopen', async () => {
    const createdAt = new Date('2026-08-25T12:34:56.000Z')
    const firstLifecycle = createDraftLifecycle(app)
    const draftId = await firstLifecycle.open(0)
    await firstLifecycle.append(draftId, [{ path: 'addTodoAt', args: { id: 3, createdAt } }])

    const reopenedLifecycle = createDraftLifecycle(app)
    expect(await reopenedLifecycle.getLog(draftId)).toEqual([
      {
        path: 'addTodoAt',
        args: { id: 3, createdAt: createdAt.toISOString() },
      },
    ])
    await reopenedLifecycle.publish(draftId)

    const { result } = await app.call('listTodos', {})
    expect(
      (result as Array<{ id: number; title: string }>).find((row) => row.id === 3)?.title,
    ).toBe(createdAt.toISOString())
  })

  test('preserves an own __proto__ key across append, reopen, and publish', async () => {
    const meta = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>
    const firstLifecycle = createDraftLifecycle(app)
    const draftId = await firstLifecycle.open(0)
    await firstLifecycle.append(draftId, [{ path: 'addTodoFromMeta', args: { id: 3, meta } }])

    const reopenedLifecycle = createDraftLifecycle(app)
    const storedMeta = (await reopenedLifecycle.getLog(draftId))[0]?.args as {
      meta: Record<string, unknown>
    }
    expect(Object.hasOwn(storedMeta.meta, '__proto__')).toBe(true)
    await reopenedLifecycle.publish(draftId)

    const { result } = await app.call('listTodos', {})
    expect(
      (result as Array<{ id: number; title: string }>).find((row) => row.id === 3)?.title,
    ).toBe('present')
  })

  const nonJsonCases: Array<{ name: string; meta: unknown }> = [
    { name: 'Map', meta: new Map([['flag', true]]) },
    { name: 'Set', meta: new Set(['flag']) },
    { name: 'NaN', meta: Number.NaN },
    { name: 'Infinity', meta: Number.POSITIVE_INFINITY },
  ]

  for (const current of nonJsonCases) {
    test(`rejects ${current.name} before derived execution`, async () => {
      const lc = createDraftLifecycle(app)
      const draftId = await lc.open(0)

      await expect(
        lc.append(draftId, [
          {
            path: 'addTodoWithMeta',
            args: { id: 3, title: 'cherry', meta: current.meta },
          },
        ]),
      ).rejects.toThrow('draft lifecycle: command args')

      expect(await lc.getLog(draftId)).toEqual([])
      const overlay = await db.execute(
        `SELECT row_key_text FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
      )
      expect((overlay as { rows: unknown[] }).rows).toEqual([])
    })
  }
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

  test('rejects a legacy procedure before it can execute against the draft tracker', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    await expect(
      lc.append(draftId, [{ path: 'legacyAddTodo', args: { id: 3, title: 'cherry' } }]),
    ).rejects.toThrow('Draft command legacyAddTodo cannot reference a legacy procedure')
    expect(await lc.getLog(draftId)).toEqual([])
  })

  test('rejects a canonical-only mutation before it can change the draft', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    await expect(
      lc.append(draftId, [{ path: 'canonicalOnlyTodo', args: { id: 3, title: 'canonical-only' } }]),
    ).rejects.toThrow(
      'Draft command canonicalOnlyTodo cannot reference a canonical-only mutation; use .command() for replay-safe handlers',
    )
    expect(await lc.getLog(draftId)).toEqual([])
    expect(await lc.inspect(draftId)).toEqual([])
  })

  test('rejects a query that was not explicitly declared as a command', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    await expect(lc.append(draftId, [{ path: 'listTodos', args: {} }])).rejects.toThrow(
      'Draft command listTodos cannot reference a query; use .command() for replay-safe handlers',
    )
    expect(await lc.getLog(draftId)).toEqual([])
  })

  test('rejects an unknown command path during preflight', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    await expect(lc.append(draftId, [{ path: 'missingCommand', args: {} }])).rejects.toThrow(
      'Draft command missingCommand references an unknown function',
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

  test('rejects a path replaced with a canonical-only mutation while append waits to execute', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    const appending = lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])
    app.functions.set('addTodo', app.functions.get('canonicalOnlyTodo')!)

    await expect(appending).rejects.toThrow(
      'Draft command addTodo cannot reference a canonical-only mutation; use .command() for replay-safe handlers',
    )
    expect(await lc.getLog(draftId)).toEqual([])
  })

  test('rechecks each publish command after an earlier handler swaps the registry', async () => {
    const addTodo = app.functions.get('addTodo')
    const renameTodo = app.functions.get('renameTodo')
    const action = app.functions.get('externalAction')
    if (
      !addTodo ||
      addTodo.type !== 'mutation' ||
      !addTodo.draftReplayable ||
      !renameTodo ||
      !action
    ) {
      throw new Error('missing command definitions')
    }
    let addRuns = 0
    let actionRuns = 0
    app.functions.set('externalAction', {
      ...action,
      handler: async () => {
        actionRuns += 1
        return 'external'
      },
    })
    app.functions.set('addTodo', {
      ...addTodo,
      handler: async (ctx, args) => {
        addRuns += 1
        const result = await addTodo.handler(ctx, args)
        if (addRuns === 2) app.functions.set('renameTodo', app.functions.get('externalAction')!)
        return result
      },
    })

    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'draft' } },
      { path: 'renameTodo', args: { id: 1, title: 'reviewed' } },
    ])

    await expect(lifecycle.publish(draftId)).rejects.toThrow(
      'Draft command renameTodo cannot reference an action',
    )
    expect(actionRuns).toBe(0)
    expect(await lifecycle.getLog(draftId)).toHaveLength(2)
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

  /** SQLSTATE 40001 rolls back the first attempt, then replays exactly one command and one derived change. */
  test('replays the whole command transaction after a serialization rollback', async () => {
    const definition = app.functions.get('addTodo')
    if (!definition || definition.type !== 'mutation') throw new Error('missing addTodo mutation')
    let handlerRuns = 0
    app.functions.set('addTodo', {
      ...definition,
      handler: async (ctx, args) => {
        handlerRuns += 1
        const result = await definition.handler(ctx, args)
        if (handlerRuns === 1) {
          throw Object.assign(new Error('forced serialization rollback'), {
            code: '40001',
          })
        }
        return result
      },
    })

    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'serialization-safe' } },
    ])

    expect(handlerRuns).toBe(2)
    expect(await lifecycle.getLog(draftId)).toHaveLength(1)
    expect(await lifecycle.inspect(draftId)).toHaveLength(1)
  })

  /** Every lifecycle authorization callback may wait while another operation advances the same draft. */
  test('authorization callbacks never run while the draft row is locked', async () => {
    const actions = ['append', 'publish', 'rebase', 'discard'] as const

    for (const [index, action] of actions.entries()) {
      const probe = makeProbe()
      const owner = createDraftLifecycle(app, { versionProbe: probe })
      const draftId = await owner.open(await probe.current())
      await owner.append(draftId, [
        { path: 'renameTodo', args: { id: 1, title: `${action}-initial` } },
      ])

      const callbackStarted = deferred()
      const releaseCallback = deferred()
      const collaborator = createProductionDraftLifecycle(app, {
        versionProbe: probe,
        resolveOwner: () => 'collaborator',
        authorizeGlobalDraft: () => true,
        authorizeDraft: async (request) => {
          if (request.action === action) {
            callbackStarted.release()
            await releaseCallback.gate
          }
          return true
        },
      })

      const operation =
        action === 'append'
          ? collaborator.append(draftId, [
              { path: 'renameTodo', args: { id: 1, title: 'collaborator' } },
            ])
          : action === 'publish'
            ? collaborator.publish(draftId)
            : action === 'rebase'
              ? collaborator.rebase(draftId)
              : collaborator.discard(draftId)

      await callbackStarted.gate
      const concurrentAppend = owner.append(draftId, [
        { path: 'renameTodo', args: { id: 2, title: `${action}-${index}` } },
      ])
      const appendCompletedBeforeRelease = await Promise.race([
        concurrentAppend.then(
          () => true,
          () => false,
        ),
        Bun.sleep(1_000).then(() => false),
      ])
      releaseCallback.release()

      expect(appendCompletedBeforeRelease).toBe(true)
      await expect(concurrentAppend).resolves.toBeArray()
      if (action === 'publish' || action === 'rebase') {
        await expect(operation).rejects.toThrow(`changed during ${action}`)
      } else if (action === 'discard') {
        await expect(operation).rejects.toThrow('changed during discard')
      } else {
        await expect(operation).resolves.toBeDefined()
      }
    }
  })

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

  test('an append during fork resolution preserves the source draft and loses no command', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0, {
      lookupKey: 'artifact:fork-race',
      summary: { commandCount: 0 },
    })
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }], {
      summary: { commandCount: 1 },
    })

    const releaseResolve = deferred()
    const enteredResolve = deferred()
    const replacing = lc.forkAndDiscard(draftId, 1, async (snapshotLog, metadata) => {
      expect(metadata).toMatchObject({
        lookupKey: 'artifact:fork-race',
        summary: { commandCount: 1 },
      })
      enteredResolve.release()
      await releaseResolve.gate
      return { commands: snapshotLog, summary: { commandCount: snapshotLog.length } }
    })

    await enteredResolve.gate
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 4, title: 'date' } }], {
      summary: { commandCount: 2 },
    })
    releaseResolve.release()

    await expect(replacing).rejects.toThrow('changed during replacement')
    expect((await lc.getLog(draftId)).map((command) => command.args)).toEqual([
      { id: 3, title: 'cherry' },
      { id: 4, title: 'date' },
    ])
    expect(await lc.findOwnedByLookupKey('artifact:fork-race')).toMatchObject({
      draftId,
      summary: { commandCount: 2 },
    })
    const stored = await db.execute(`SELECT draft_id FROM wystack_drafts`)
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((stored as any).rows.map((row: { draft_id: string }) => row.draft_id)).toEqual([draftId])
  })

  test('fork and discard replaces the source while retaining its lookup identity', async () => {
    const lc = createDraftLifecycle(app)
    const sourceId = await lc.open(0, {
      lookupKey: 'artifact:fork-success',
      summary: { commandCount: 0 },
    })
    await lc.append(sourceId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }], {
      summary: { commandCount: 1 },
    })

    const replacementId = await lc.forkAndDiscard(sourceId, 1, (snapshotLog, metadata) => {
      expect(metadata).toMatchObject({
        lookupKey: 'artifact:fork-success',
        summary: { commandCount: 1 },
      })
      return {
        commands: [...snapshotLog, { path: 'addTodo', args: { id: 4, title: 'date' } }],
        summary: { commandCount: 2 },
      }
    })

    await expect(lc.getLog(sourceId)).rejects.toThrow('unknown draft')
    expect(await lc.getLog(replacementId)).toHaveLength(2)
    expect(await lc.inspect(replacementId)).toHaveLength(2)
    expect(await lc.findOwnedByLookupKey('artifact:fork-success')).toMatchObject({
      draftId: replacementId,
      lookupKey: 'artifact:fork-success',
      summary: { commandCount: 2 },
    })
  })

  test('the command-array fork resolver preserves discovery metadata', async () => {
    const lc = createDraftLifecycle(app)
    const sourceId = await lc.open(1, {
      lookupKey: 'artifact:legacy-fork',
      summary: { commandCount: 0 },
    })
    await lc.append(sourceId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }], {
      summary: { commandCount: 1 },
    })

    const replacementId = await lc.forkAndDiscard(sourceId, 2, (snapshotLog) => snapshotLog)

    expect(await lc.findOwnedByLookupKey('artifact:legacy-fork')).toMatchObject({
      draftId: replacementId,
      lookupKey: 'artifact:legacy-fork',
      summary: { commandCount: 1 },
    })
    expect(await lc.getLog(replacementId)).toHaveLength(1)
    await expect(lc.getLog(sourceId)).rejects.toThrow('unknown draft')
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

  test('two concurrent publishes commit exactly once through the publication mutex', async () => {
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

  test('a failed publish releases its publication mutex — append and discard work again', async () => {
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

    const a = lc.append(
      draftId,
      [
        { path: 'addTodo', args: { id: 3, title: 'c1' } },
        { path: 'addTodo', args: { id: 4, title: 'c2' } },
      ],
      { summary: { last: 'c2' } },
    )
    const b = lc.append(
      draftId,
      [
        { path: 'addTodo', args: { id: 5, title: 'c3' } },
        { path: 'addTodo', args: { id: 6, title: 'c4' } },
      ],
      { summary: { last: 'c4' } },
    )
    await Promise.all([a, b])

    expect((await lc.getLog(draftId)).map((c) => (c.args as { title: string }).title)).toEqual([
      'c1',
      'c2',
      'c3',
      'c4',
    ])
    expect((await lc.listOwned())[0]).toMatchObject({ summary: { last: 'c4' } })
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
    const overlay = await db.execute(
      `SELECT row_key_text FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((overlay as any).rows).toHaveLength(0)
    const { result: canonical } = await app.call('listTodos', {})
    expect((canonical as { id: number }[]).map((r) => r.id).sort()).toEqual([1, 2])
  })

  test('a publish queued behind a failed append observes its atomic rollback', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)

    const appending = lc.append(draftId, [
      { path: 'addTodo', args: { id: 3, title: 'cherry' } },
      { path: 'boom', args: {} },
    ])
    // Issued before the failure is observable, so it is admitted and queues.
    const publishing = lc.publish(draftId)

    await expect(appending).rejects.toThrow('command boom')
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
    return {
      emitted,
      unsubscribe,
      tags: () => emitted.flatMap((s) => [...s]).sort(),
    }
  }

  test('append announces the OVERLAY write so draft-scoped subscriptions refetch', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    const cap = captureEmits()

    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    // The draft-specific identity, not the canonical one — canonical is untouched until publish.
    expect(cap.tags()).toEqual([draftInvalidationIdentity(schema.todos, draftId)])
    cap.unsubscribe()
  })

  test('a mid-batch failure rolls back the overlay, log, and invalidation', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    const cap = captureEmits()

    await expect(
      lc.append(draftId, [
        { path: 'addTodo', args: { id: 3, title: 'cherry' } },
        { path: 'boom', args: {} },
      ]),
    ).rejects.toThrow('command boom')

    expect(cap.tags()).toEqual([])
    expect(await lc.getLog(draftId)).toEqual([])
    const overlay = await db.execute(
      `SELECT row_key_text FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((overlay as any).rows).toHaveLength(0)
    cap.unsubscribe()
  })

  test('publish announces both the canonical replay and the draft sweep', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const cap = captureEmits()
    await lc.publish(draftId)

    // `todos` announces the canonical row and the draft-specific identity announces
    // the derived-state sweep. A draft-scoped subscription must observe both.
    expect(cap.tags()).toEqual([draftInvalidationIdentity(schema.todos, draftId), 'todos'].sort())
    cap.unsubscribe()
  })

  test('a FAILED publish announces nothing (the transaction rolled back)', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const cap = captureEmits()
    await expect(
      lc.publish(draftId, (logToBind) => [...logToBind, { path: 'boom', args: {} }]),
    ).rejects.toThrow('command boom')

    // Nothing durably changed, so announcing would trigger a pointless refetch
    // storm — and would tell clients a publish landed when it did not.
    expect(cap.emitted).toEqual([])
    cap.unsubscribe()
    await lc.discard(draftId)
  })

  test('discard announces the draft sweep and nothing canonical', async () => {
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'addTodo', args: { id: 3, title: 'cherry' } }])

    const cap = captureEmits()
    await lc.discard(draftId)

    expect(cap.tags()).toEqual([draftInvalidationIdentity(schema.todos, draftId)])
    cap.unsubscribe()
  })

  test('a READ-ONLY draft announces nothing on discard', async () => {
    // `touchedTables` records reads as well as writes — a `from(t)…delete()`
    // routes through `from`, so the recorder cannot tell them apart. Deriving
    // the sweep tags from it would announce a draft identity for a draft that
    // never wrote a derived row, costing every draft-scoped subscriber a
    // full recompute for a sweep that deleted nothing. The tags come from what
    // the tracker actually reported written instead.
    const lc = createDraftLifecycle(app)
    const draftId = await lc.open(0)
    await lc.append(draftId, [{ path: 'readTodos', args: {} }])

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

    const overlay = await db.execute(
      `SELECT * FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((overlay as any).rows).toHaveLength(2)

    // Nothing durably changed, so nothing should have been announced.
    expect(cap.emitted).toEqual([])
    cap.unsubscribe()

    // The draft stays live and retryable, symmetric with a failed publish.
    expect(await lc.getLog(draftId)).toHaveLength(2)

    // Retry: the indexed sweep succeeds and announces both draft-specific identities.
    const cap2 = captureEmits()
    await lc.discard(draftId)
    expect(cap2.tags()).toEqual(
      [
        draftInvalidationIdentity(schema.dashboards, draftId),
        draftInvalidationIdentity(schema.todos, draftId),
      ].sort(),
    )
    cap2.unsubscribe()

    const overlayAfter = await db.execute(
      `SELECT * FROM wystack_draft_row_changes WHERE draft_id = '${draftId}'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any
    expect((overlayAfter as any).rows).toHaveLength(0)
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
      {
        path: 'removeTodo',
        args: { id: 1 },
        compactionKey: 'todo:1',
        kind: 'delete',
      },
      {
        path: 'addTodo',
        args: { id: 1, title: 'REPLACED' },
        compactionKey: 'todo:1',
        kind: 'create',
      },
    ])

    // Both halves survive compaction, in order.
    expect((await lc.getLog(draftId)).map((c) => c.kind)).toEqual(['delete', 'create'])

    // And the overlay already shows the replacement (the derived write is a
    // sparse upsert, so the create clears the tombstone the delete set).
    const draftRows = await app.system.createTracked().withDraft(draftId).from(schema.todos).all()
    expect(Object.fromEntries(draftRows.map((r) => [r['id'], r['title']]))[1]).toBe('REPLACED')

    await lc.publish(draftId)

    const { result: canonical } = await app.call('listTodos', {})
    const rows = canonical as { id: number; title: string }[]
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === 1)?.title).toBe('REPLACED')
  })

  test('a replacement does not inherit an omitted nullable field from the deleted row', async () => {
    const lifecycle = createDraftLifecycle(app)
    const draftId = await lifecycle.open(0)
    await lifecycle.append(draftId, [
      {
        path: 'removeReplaceableTodo',
        args: { id: 1 },
        compactionKey: 'replaceable:1',
        kind: 'delete',
      },
      {
        path: 'addReplaceableTodo',
        args: { id: 1, title: 'replacement' },
        compactionKey: 'replaceable:1',
        kind: 'create',
      },
    ])

    const effective = await app.system
      .createTracked()
      .withDraft(draftId)
      .from(schema.replaceableTodos)
      .all()
    expect(effective).toEqual([{ id: 1, title: 'replacement', note: null }])

    await lifecycle.publish(draftId)

    const { result: published } = await app.call('listReplaceableTodos', {})
    expect(published).toEqual(effective)
  })
})
