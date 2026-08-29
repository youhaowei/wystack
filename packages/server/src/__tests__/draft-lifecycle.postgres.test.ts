import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { defineSchema, int, table, text } from '@wystack/db'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createDraftLifecycle } from '../draft-lifecycle'
import { defineApp } from '../define-app'

const postgresUrl = process.env['WYSTACK_TEST_POSTGRES_URL']
const describeWithPostgres = postgresUrl ? describe : describe.skip

const schema = defineSchema({
  alphaRows: table({ id: int.primaryKey(), title: text, revision: int })
    .revision('revision')
    .draftable(),
  dashboards: table({ id: int.primaryKey(), items: text }).draftable(),
  todos: table({ id: int.primaryKey(), title: text }).draftable(),
  versionedTodos: table({ id: int.primaryKey(), title: text, revision: int })
    .revision('revision')
    .draftable(),
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
        addTodo: wy.procedure
          .input({ id: int, title: text })
          .mutation(async (ctx, args) => ctx.db.into(schema.todos).insert(args)),
        addToDashboard: wy.procedure.input({ id: int, item: text }).mutation(async (ctx, args) => {
          const current = (await ctx.db.from(schema.dashboards).first()) as {
            id: number
            items: string
          } | null
          const items = current?.items ? `${current.items},${args.item}` : args.item
          return ctx.db.from(schema.dashboards).update({ items })
        }),
        renameAlphaThenZeta: wy.procedure
          .input({ id: int, title: text })
          .mutation(async (ctx, args) => {
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
          .mutation(async (ctx, args) => {
            const barrier = ctx['writeBarrier']
            if (typeof barrier === 'function') await barrier()
            return ctx.db
              .from(schema.versionedTodos)
              .where({ op: 'eq', column: 'id', value: args.id })
              .update({ title: args.title })
          }),
        renameZetaThenAlpha: wy.procedure
          .input({ id: int, title: text })
          .mutation(async (ctx, args) => {
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

  test('concurrent appends serialize one durable log across separate connections', async () => {
    const first = lifecycle(firstApp)
    const second = lifecycle(secondApp)
    const draftId = await first.open(0, { context: privilegedContext })
    await second.getLog(draftId, { context: privilegedContext })

    await Promise.all([
      first.append(draftId, [{ path: 'addTodo', args: { id: 1, title: 'first' } }], {
        context: privilegedContext,
      }),
      second.append(draftId, [{ path: 'addTodo', args: { id: 2, title: 'second' } }], {
        context: privilegedContext,
      }),
    ])

    const log = await first.getLog(draftId, { context: privilegedContext })
    expect(log).toHaveLength(2)
    expect(log.map((command) => (command.args as { id: number }).id).sort()).toEqual([1, 2])
    expect(await first.inspect(draftId, { context: privilegedContext })).toHaveLength(2)
  })

  test('concurrent publishes replay exactly once across separate connections', async () => {
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
    const waitDeadline = Date.now() + 2_000
    while (true) {
      const [activity] = await admin<{ wait_event_type: string | null }[]>`
        SELECT wait_event_type
        FROM pg_stat_activity
        WHERE application_name = ${`${namespace}_second`}
      `
      if (activity?.wait_event_type === 'Lock') break
      if (Date.now() >= waitDeadline) {
        throw new Error('publish did not block on the append-held zeta row')
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
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
