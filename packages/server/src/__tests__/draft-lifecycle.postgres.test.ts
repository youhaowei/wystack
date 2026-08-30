import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { defineSchema, int, table, text } from '@wystack/db'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createDraftLifecycle } from '../draft-lifecycle'
import { defineApp } from '../define-app'

const postgresUrl = process.env['WYSTACK_TEST_POSTGRES_URL']
const describeWithPostgres = postgresUrl ? describe : describe.skip

const schema = defineSchema({
  aCodeParents: table({ id: int.primaryKey(), code: text.unique() }).draftable(),
  aChildren: table({ id: int.primaryKey(), parentId: int.references('zParents') }).draftable(),
  alphaRows: table({ id: int.primaryKey(), title: text, revision: int })
    .revision('revision')
    .draftable(),
  dashboards: table({ id: int.primaryKey(), items: text }).draftable(),
  todos: table({ id: int.primaryKey(), title: text }).draftable(),
  versionedTodos: table({ id: int.primaryKey(), title: text, revision: int })
    .revision('revision')
    .draftable(),
  treeNodes: table({
    id: int.primaryKey(),
    parentId: int.nullable().references('treeNodes'),
  }).draftable(),
  zCodeChildren: table({
    id: int.primaryKey(),
    parentCode: text.references('aCodeParents', 'code'),
  }).draftable(),
  zParents: table({ id: int.primaryKey(), name: text }).draftable(),
  zetaRows: table({ id: int.primaryKey(), title: text, revision: int })
    .revision('revision')
    .draftable(),
})
const wy = defineApp<Record<string, unknown>>({ permissions: {} })
const privilegedContext = {
  principal: { kind: 'user' as const, userId: 'postgres-proof-user' },
  mayManageGlobalDrafts: true,
}

describeWithPostgres('draft lifecycle — real PostgreSQL multi-connection concurrency', () => {
  const namespace = `wystack_concurrency_${process.pid}_${Date.now()}`
  let admin: ReturnType<typeof postgres>
  let firstClient: ReturnType<typeof postgres>
  let secondClient: ReturnType<typeof postgres>
  let firstApp: Awaited<ReturnType<typeof wy.build>>
  let secondApp: Awaited<ReturnType<typeof wy.build>>

  async function buildApp(client: ReturnType<typeof postgres>) {
    const db = drizzle(client)
    return wy.build({
      db,
      functions: {
        retargetAndRenameCode: wy.procedure
          .input({ childId: int, parentId: int, nextParentCode: text, nextCode: text })
          .command(async (ctx, args) => {
            await ctx.db
              .from(schema.aCodeParents)
              .where({ op: 'eq', column: 'id', value: args.parentId })
              .update({ code: args.nextCode })
            return ctx.db
              .from(schema.zCodeChildren)
              .where({ op: 'eq', column: 'id', value: args.childId })
              .update({ parentCode: args.nextParentCode })
          }),
        replaceCodeFamily: wy.procedure
          .input({ childId: int, parentId: int, code: text })
          .command(async (ctx, args) => {
            await ctx.db
              .from(schema.zCodeChildren)
              .where({ op: 'eq', column: 'id', value: args.childId })
              .delete()
            await ctx.db
              .from(schema.aCodeParents)
              .where({ op: 'eq', column: 'id', value: args.parentId })
              .delete()
            await ctx.db.into(schema.aCodeParents).insert({ id: args.parentId, code: args.code })
            return ctx.db
              .into(schema.zCodeChildren)
              .insert({ id: args.childId, parentCode: args.code })
          }),
        addFamily: wy.procedure
          .input({ parentId: int, childId: int })
          .command(async (ctx, args) => {
            await ctx.db.into(schema.zParents).insert({ id: args.parentId, name: 'parent' })
            return ctx.db
              .into(schema.aChildren)
              .insert({ id: args.childId, parentId: args.parentId })
          }),
        addTreePair: wy.procedure
          .input({ parentId: int, childId: int })
          .command(async (ctx, args) => {
            await ctx.db.into(schema.treeNodes).insert({ id: args.parentId, parentId: null })
            return ctx.db
              .into(schema.treeNodes)
              .insert({ id: args.childId, parentId: args.parentId })
          }),
        addTodo: wy.procedure.input({ id: int, title: text }).command(async (ctx, args) => {
          const barrier = ctx['initialCommandBarrier']
          if (typeof barrier === 'function') await barrier()
          return ctx.db.into(schema.todos).insert(args)
        }),
        addToDashboard: wy.procedure.input({ id: int, item: text }).command(async (ctx, args) => {
          const current = (await ctx.db.from(schema.dashboards).first()) as {
            id: number
            items: string
          } | null
          const items = current?.items ? `${current.items},${args.item}` : args.item
          return ctx.db.from(schema.dashboards).update({ items })
        }),
        renameAlphaThenZeta: wy.procedure
          .input({ id: int, title: text })
          .command(async (ctx, args) => {
            await ctx.db
              .from(schema.alphaRows)
              .where({ op: 'eq', column: 'id', value: args.id })
              .update({ title: args.title })
            const barrier = ctx['crossTableBarrier']
            if (typeof barrier === 'function') await barrier()
            return ctx.db
              .from(schema.zetaRows)
              .where({ op: 'eq', column: 'id', value: args.id })
              .update({ title: args.title })
          }),
        renameVersionedTodo: wy.procedure
          .input({ id: int, title: text })
          .command(async (ctx, args) => {
            const barrier = ctx['writeBarrier']
            if (typeof barrier === 'function') await barrier()
            return ctx.db
              .from(schema.versionedTodos)
              .where({ op: 'eq', column: 'id', value: args.id })
              .update({ title: args.title })
          }),
        renameZetaThenAlpha: wy.procedure
          .input({ id: int, title: text })
          .command(async (ctx, args) => {
            await ctx.db
              .from(schema.zetaRows)
              .where({ op: 'eq', column: 'id', value: args.id })
              .update({ title: args.title })
            const barrier = ctx['crossTableBarrier']
            if (typeof barrier === 'function') await barrier()
            return ctx.db
              .from(schema.alphaRows)
              .where({ op: 'eq', column: 'id', value: args.id })
              .update({ title: args.title })
          }),
      },
    })
  }

  function lifecycle(app: Awaited<ReturnType<typeof wy.build>>) {
    return createDraftLifecycle(app, {
      authorizeGlobalDraft: ({ context }) => context.mayManageGlobalDrafts === true,
    })
  }

  async function waitForConnectionLock(
    applicationName: string,
    failureMessage: string,
    lockType?: string,
  ): Promise<void> {
    const deadline = Date.now() + 2_000
    while (true) {
      const [lock] = await admin<{ locktype: string }[]>`
        SELECT l.locktype
        FROM pg_locks l
        JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE a.application_name = ${applicationName}
          AND NOT l.granted
          AND (${lockType ?? null}::text IS NULL OR l.locktype = ${lockType ?? null})
        LIMIT 1
      `
      if (lock) return
      if (Date.now() >= deadline) {
        throw new Error(failureMessage)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  beforeAll(async () => {
    admin = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE SCHEMA "${namespace}"`)

    firstClient = postgres(postgresUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: namespace, application_name: `${namespace}_first` },
    })
    secondClient = postgres(postgresUrl!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: namespace, application_name: `${namespace}_second` },
    })
    await firstClient.unsafe(
      'CREATE TABLE dashboards (id INTEGER PRIMARY KEY, items TEXT NOT NULL)',
    )
    await firstClient.unsafe('CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
    await firstClient.unsafe(
      'CREATE TABLE "aCodeParents" (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE)',
    )
    await firstClient.unsafe(
      'CREATE TABLE "zCodeChildren" (id INTEGER PRIMARY KEY, "parentCode" TEXT NOT NULL REFERENCES "aCodeParents"(code))',
    )
    await firstClient.unsafe('CREATE TABLE "zParents" (id INTEGER PRIMARY KEY, name TEXT NOT NULL)')
    await firstClient.unsafe(
      'CREATE TABLE "aChildren" (id INTEGER PRIMARY KEY, "parentId" INTEGER NOT NULL REFERENCES "zParents"(id))',
    )
    await firstClient.unsafe(
      'CREATE TABLE "treeNodes" (id INTEGER PRIMARY KEY, "parentId" INTEGER REFERENCES "treeNodes"(id))',
    )
    await firstClient.unsafe(
      'CREATE TABLE "versionedTodos" (id INTEGER PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL)',
    )
    await firstClient.unsafe(
      'CREATE TABLE "alphaRows" (id INTEGER PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL)',
    )
    await firstClient.unsafe(
      'CREATE TABLE "zetaRows" (id INTEGER PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL)',
    )
    await firstClient.unsafe("INSERT INTO dashboards (id, items) VALUES (1, 'a')")
    await firstClient.unsafe(
      `INSERT INTO "aCodeParents" (id, code) VALUES (1, 'old'), (2, 'stable'), (3, 'replace')`,
    )
    await firstClient.unsafe(
      `INSERT INTO "zCodeChildren" (id, "parentCode") VALUES (1, 'old'), (3, 'replace')`,
    )
    await firstClient.unsafe(
      `INSERT INTO "versionedTodos" (id, title, revision) VALUES (1, 'canonical', 1)`,
    )
    await firstClient.unsafe(
      `INSERT INTO "alphaRows" (id, title, revision) VALUES (1, 'canonical', 1)`,
    )
    await firstClient.unsafe(
      `INSERT INTO "zetaRows" (id, title, revision) VALUES (1, 'canonical', 1)`,
    )
    ;[firstApp, secondApp] = await Promise.all([buildApp(firstClient), buildApp(secondClient)])
  })

  afterEach(async () => {
    await secondClient?.unsafe('RESET default_transaction_isolation')
  })

  afterAll(async () => {
    await Promise.all([firstClient?.end({ timeout: 1 }), secondClient?.end({ timeout: 1 })])
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`)
      await admin.end({ timeout: 1 })
    }
  })

  test('concurrent first use installs framework storage across separate connections', async () => {
    const first = lifecycle(firstApp)
    const second = lifecycle(secondApp)
    const [firstDraft, secondDraft] = await Promise.all([
      first.open(0, { context: privilegedContext }),
      second.open(0, { context: privilegedContext }),
    ])

    expect(
      await Promise.all([
        first.getLog(firstDraft, { context: privilegedContext }),
        second.getLog(secondDraft, { context: privilegedContext }),
      ]),
    ).toEqual([[], []])
  })

  test('exclusive owned lookup initialization sees the winner under a repeatable-read host default', async () => {
    const first = lifecycle(firstApp)
    const second = lifecycle(secondApp)
    const lookupKey = 'postgres-proof:exclusive-open'
    await secondClient.unsafe("SET default_transaction_isolation TO 'repeatable read'")
    let commandStarted!: () => void
    const firstCommandStarted = new Promise<void>((resolve) => {
      commandStarted = resolve
    })
    let releaseFirst!: () => void
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const firstResultPromise = first.getOrOpenWithCommands(
      0,
      [{ id: 'first', path: 'addTodo', args: { id: 20_001, title: 'first contender' } }],
      {
        context: {
          ...privilegedContext,
          initialCommandBarrier: async () => {
            commandStarted()
            await firstMayCommit
          },
        },
        lookupKey,
      },
    )
    await firstCommandStarted
    const secondResultPromise = second.getOrOpenWithCommands(
      0,
      [{ id: 'second', path: 'addTodo', args: { id: 20_002, title: 'second contender' } }],
      { context: privilegedContext, lookupKey },
    )

    let lockWaitError: unknown
    try {
      await waitForConnectionLock(
        `${namespace}_second`,
        'second initializer did not wait on the owned-lookup advisory lock',
        'advisory',
      )
    } catch (error) {
      lockWaitError = error
    } finally {
      releaseFirst()
    }
    const [firstResult, secondResult] = await Promise.all([firstResultPromise, secondResultPromise])
    if (lockWaitError) throw lockWaitError

    const [counts] = await firstClient<{ drafts: string; commands: string }[]>`
      SELECT
        (SELECT count(*) FROM wystack_drafts WHERE lookup_key = ${lookupKey}) AS drafts,
        (SELECT count(*) FROM wystack_draft_commands c
          JOIN wystack_drafts d ON d.draft_id = c.draft_id
          WHERE d.lookup_key = ${lookupKey}) AS commands
    `
    expect({
      sameDraft: firstResult.draftId === secondResult.draftId,
      firstCreated: firstResult.created,
      secondCreated: secondResult.created,
      firstResultIds: firstResult.results.map(({ id }) => id),
      secondResults: secondResult.results,
      drafts: Number(counts?.drafts),
      commands: Number(counts?.commands),
    }).toEqual({
      sameDraft: true,
      firstCreated: true,
      secondCreated: false,
      firstResultIds: ['first'],
      secondResults: [],
      drafts: 1,
      commands: 1,
    })
  })

  test('publishes immediate foreign keys in dependency order', async () => {
    const draft = lifecycle(firstApp)
    const familyDraft = await draft.open(0, { context: privilegedContext })
    await draft.append(
      familyDraft,
      [{ path: 'addFamily', args: { parentId: 40_001, childId: 40_002 } }],
      { context: privilegedContext },
    )
    expect((await draft.inspect(familyDraft, { context: privilegedContext }))[0]?.table).toBe(
      'aChildren',
    )
    await draft.publish(familyDraft, undefined, { context: privilegedContext })

    const [family] = await firstClient<{ child_id: number; parent_id: number }[]>`
      SELECT c.id AS child_id, p.id AS parent_id
      FROM "aChildren" c JOIN "zParents" p ON p.id = c."parentId"
      WHERE c.id = 40002
    `
    expect(family).toEqual({ child_id: 40_002, parent_id: 40_001 })

    const treeDraft = await draft.open(0, { context: privilegedContext })
    await draft.append(
      treeDraft,
      [{ path: 'addTreePair', args: { parentId: 40_011, childId: 40_010 } }],
      { context: privilegedContext },
    )
    await draft.publish(treeDraft, undefined, { context: privilegedContext })
    const [tree] = await firstClient<{ child_id: number; parent_id: number }[]>`
      SELECT child.id AS child_id, parent.id AS parent_id
      FROM "treeNodes" child JOIN "treeNodes" parent ON parent.id = child."parentId"
      WHERE child.id = 40010
    `
    expect(tree).toEqual({ child_id: 40_010, parent_id: 40_011 })
  })

  test('orders unique-key retargeting and phased replacements for immediate foreign keys', async () => {
    const draft = lifecycle(firstApp)
    const retargetDraft = await draft.open(0, { context: privilegedContext })
    await draft.append(
      retargetDraft,
      [
        {
          path: 'retargetAndRenameCode',
          args: {
            childId: 1,
            parentId: 1,
            nextParentCode: 'stable',
            nextCode: 'renamed',
          },
        },
      ],
      { context: privilegedContext },
    )
    await draft.publish(retargetDraft, undefined, { context: privilegedContext })
    const [retargeted] = await firstClient<{ code: string; parent_code: string }[]>`
      SELECT p.code, c."parentCode" AS parent_code
      FROM "aCodeParents" p CROSS JOIN "zCodeChildren" c
      WHERE p.id = 1 AND c.id = 1
    `
    expect(retargeted).toEqual({ code: 'renamed', parent_code: 'stable' })

    const replaceDraft = await draft.open(0, { context: privilegedContext })
    await draft.append(
      replaceDraft,
      [{ path: 'replaceCodeFamily', args: { parentId: 3, childId: 3, code: 'replace' } }],
      { context: privilegedContext },
    )
    await draft.publish(replaceDraft, undefined, { context: privilegedContext })
    const [replacement] = await firstClient<{ child_id: number }[]>`
      SELECT c.id AS child_id FROM "zCodeChildren" c
      JOIN "aCodeParents" p ON p.code = c."parentCode" WHERE c.id = 3
    `
    expect(replacement).toEqual({ child_id: 3 })
  })

  test('a paused append retries after the concurrent winner and commits last', async () => {
    const first = lifecycle(firstApp)
    const second = lifecycle(secondApp)
    const draftId = await first.open(0, { context: privilegedContext })
    await second.getLog(draftId, { context: privilegedContext })

    let firstAttemptStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      firstAttemptStarted = resolve
    })
    let resumeFirstAttempt!: () => void
    const firstMayContinue = new Promise<void>((resolve) => {
      resumeFirstAttempt = resolve
    })
    let firstHandlerRuns = 0
    const firstBarrier = async () => {
      firstHandlerRuns += 1
      if (firstHandlerRuns > 1) return
      firstAttemptStarted()
      await firstMayContinue
    }

    const firstAppend = first.append(
      draftId,
      [{ path: 'addTodo', args: { id: 1, title: 'first' } }],
      {
        context: { ...privilegedContext, initialCommandBarrier: firstBarrier },
        summary: { last: 'first' },
      },
    )
    await firstStarted
    const secondAppend = second.append(
      draftId,
      [{ path: 'addTodo', args: { id: 2, title: 'second' } }],
      { context: privilegedContext, summary: { last: 'second' } },
    )
    const [secondOutcome] = await Promise.allSettled([secondAppend])
    resumeFirstAttempt()
    const [firstOutcome] = await Promise.allSettled([firstAppend])

    expect([firstOutcome, secondOutcome]).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ])

    const log = await first.getLog(draftId, { context: privilegedContext })
    expect(log.map((command) => (command.args as { id: number }).id)).toEqual([2, 1])
    expect(
      (await first.listOwned({ context: privilegedContext })).find(
        (draft) => draft.draftId === draftId,
      ),
    ).toMatchObject({ draftId, summary: { last: 'first' } })
    expect(firstHandlerRuns).toBe(2)
    expect(await first.inspect(draftId, { context: privilegedContext })).toHaveLength(2)
  })

  test('concurrent publishes apply reviewed changes exactly once', async () => {
    const first = lifecycle(firstApp)
    const second = lifecycle(secondApp)
    const draftId = await first.open(0, { context: privilegedContext })
    await first.append(draftId, [{ path: 'addToDashboard', args: { id: 1, item: 'z' } }], {
      context: privilegedContext,
    })

    let waiting = 0
    let release!: () => void
    const bothResolved = new Promise<void>((resolve) => {
      release = resolve
    })
    const synchronize = async <T>(log: T): Promise<T> => {
      waiting += 1
      if (waiting === 2) release()
      await bothResolved
      return log
    }

    const outcomes = await Promise.allSettled([
      first.publish(draftId, synchronize, { context: privilegedContext }),
      second.publish(draftId, synchronize, { context: privilegedContext }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    )
    expect(rejected).toHaveLength(1)
    expect(String(rejected[0]?.reason)).toContain('unknown draft')

    const [row] = await firstClient<{ items: string }[]>`SELECT items FROM dashboards WHERE id = 1`
    expect(row?.items).toBe('a,z')
  })

  /** A concurrent append can advance the draft while published graph validation is paused, forcing publish to abort. */
  test('published graph validation runs before the final draft-row CAS', async () => {
    let validationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      validationStarted = resolve
    })
    let releaseValidation!: () => void
    const release = new Promise<void>((resolve) => {
      releaseValidation = resolve
    })
    const first = createDraftLifecycle(firstApp, {
      authorizeGlobalDraft: ({ context }) => context.mayManageGlobalDrafts === true,
      validateGraph: async ({ phase }) => {
        if (phase === 'published') {
          validationStarted()
          await release
        }
      },
    })
    const second = lifecycle(secondApp)
    const draftId = await first.open(0, { context: privilegedContext })
    await first.append(
      draftId,
      [{ path: 'addTodo', args: { id: 30_001, title: 'published candidate' } }],
      { context: privilegedContext },
    )

    const publishing = first.publish(draftId, undefined, { context: privilegedContext })
    await started
    await second.append(
      draftId,
      [{ path: 'addTodo', args: { id: 30_002, title: 'concurrent append' } }],
      { context: privilegedContext },
    )
    releaseValidation()

    await expect(publishing).rejects.toThrow('changed during publish')
    expect(await first.getLog(draftId, { context: privilegedContext })).toHaveLength(2)
  })

  /** Draft mutation and publish may overlap on one row without deadlocking because both lock the ledger first. */
  test('draft writes and publish share ledger-before-canonical lock order', async () => {
    const first = lifecycle(firstApp)
    const second = lifecycle(secondApp)
    const firstDraft = await first.open(0, { context: privilegedContext })
    const secondDraft = await second.open(0, { context: privilegedContext })
    const initial = [{ path: 'renameVersionedTodo', args: { id: 1, title: 'initial' } }]
    await first.append(firstDraft, initial, { context: privilegedContext })
    await second.append(secondDraft, initial, { context: privilegedContext })

    let waiting = 0
    let release!: () => void
    const bothReady = new Promise<void>((resolve) => {
      release = resolve
    })
    const writeBarrier = async () => {
      waiting += 1
      if (waiting === 2) release()
      await bothReady
    }
    const outcomes = await Promise.allSettled([
      first.append(
        firstDraft,
        [{ path: 'renameVersionedTodo', args: { id: 1, title: 'draft-write' } }],
        { context: { ...privilegedContext, writeBarrier } },
      ),
      second.publish(secondDraft, undefined, {
        context: { ...privilegedContext, writeBarrier },
      }),
    ])

    expect(outcomes).toEqual([
      expect.objectContaining({ status: 'fulfilled' }),
      expect.objectContaining({ status: 'fulfilled' }),
    ])
  })

  /** Opposite A-to-Z and Z-to-A handlers may deadlock once; WyStack retries the entire losing transaction. */
  test('cross-table draft replay recovers from opposite handler lock order', async () => {
    const first = lifecycle(firstApp)
    const second = lifecycle(secondApp)
    const appendDraft = await first.open(0, { context: privilegedContext })
    const publishDraft = await second.open(0, { context: privilegedContext })
    await second.append(
      publishDraft,
      [{ path: 'renameAlphaThenZeta', args: { id: 1, title: 'published' } }],
      { context: privilegedContext },
    )

    let appendReached!: () => void
    const appendHasZeta = new Promise<void>((resolve) => {
      appendReached = resolve
    })
    let release!: () => void
    const appendMayContinue = new Promise<void>((resolve) => {
      release = resolve
    })
    let appendHandlerRuns = 0
    const appendBarrier = async () => {
      appendHandlerRuns += 1
      if (appendHandlerRuns > 1) return
      appendReached()
      await appendMayContinue
    }

    const appending = first.append(
      appendDraft,
      [{ path: 'renameZetaThenAlpha', args: { id: 1, title: 'draft' } }],
      { context: { ...privilegedContext, crossTableBarrier: appendBarrier } },
    )
    await appendHasZeta
    const publishing = second.publish(publishDraft, undefined, {
      context: privilegedContext,
    })
    await waitForConnectionLock(
      `${namespace}_second`,
      'publish did not block on the append-held zeta row',
      'transactionid',
    )
    release()

    await expect(Promise.all([appending, publishing])).resolves.toHaveLength(2)
    expect(appendHandlerRuns).toBeGreaterThanOrEqual(1)
    expect(await first.getLog(appendDraft, { context: privilegedContext })).toHaveLength(1)
    await expect(second.getLog(publishDraft, { context: privilegedContext })).rejects.toThrow(
      'unknown draft',
    )
    const [alpha] = await firstClient<{ title: string }[]>`
      SELECT title FROM "alphaRows" WHERE id = 1
    `
    const [zeta] = await firstClient<{ title: string }[]>`
      SELECT title FROM "zetaRows" WHERE id = 1
    `
    expect([alpha?.title, zeta?.title]).toEqual(['published', 'published'])
  })
})
