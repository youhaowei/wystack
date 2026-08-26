import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { defineSchema, int, table, text } from '@wystack/db'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createDraftLifecycle } from '../draft-lifecycle'
import { defineApp } from '../define-app'

const postgresUrl = process.env['WYSTACK_TEST_POSTGRES_URL']
const describeWithPostgres = postgresUrl ? describe : describe.skip

const schema = defineSchema({
  dashboards: table({ id: int.primaryKey(), items: text }).draftable(),
  todos: table({ id: int.primaryKey(), title: text }).draftable(),
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

    firstClient = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    secondClient = postgres(postgresUrl!, { max: 1, onnotice: () => {} })
    await Promise.all([
      firstClient.unsafe(`SET search_path TO "${namespace}"`),
      secondClient.unsafe(`SET search_path TO "${namespace}"`),
    ])
    await firstClient.unsafe(
      'CREATE TABLE dashboards (id INTEGER PRIMARY KEY, items TEXT NOT NULL)',
    )
    await firstClient.unsafe('CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL)')
    await firstClient.unsafe("INSERT INTO dashboards (id, items) VALUES (1, 'a')")
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
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)

    const [row] = await firstClient<{ items: string }[]>`SELECT items FROM dashboards WHERE id = 1`
    expect(row?.items).toBe('a,z')
  })
})
