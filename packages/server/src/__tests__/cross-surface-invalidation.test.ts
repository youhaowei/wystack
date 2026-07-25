// Cross-surface invalidation — the regression guard for the two-instance bug.
//
// The bug: REST and WS ran as two processes ⇒ two WyStackApp instances ⇒ two
// invalidation sources. A REST mutation wrote the DB but fanned out on the REST
// process's source, which no subscription listened to — live WS subscribers
// never saw REST-driven writes.
//
// The fix: the app owns ONE `invalidationSource`; `app.call` fuses emit onto it
// after any write. Collapsed to one process, REST's typed `createCaller` and the
// WS subscription router share that one source, so a REST write reaches a live
// subscription.
//
// What THIS test pins (distinct from invalidation-router.test.ts, which drives
// the router with a manual `emit`): the write is driven the way REST drives it —
// through `createCaller(app, ctx).mutation(args)` and through raw `app.call` —
// with NO manual `emit` and NO WS engine in the loop. The only thing carrying
// the signal is the app's fused source. If the fuse regresses, these go red.

import { describe, test, expect } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { defineApp } from '../index'
import { createCaller } from '../caller'
import { createInvalidationRouter } from '../engine/invalidation-router'
import { createInMemorySubscriptionStore } from '../engine/subscription-store'
import type { SubscriptionEntry } from '../engine/subscription-store'

const schema = defineSchema({
  todos: { id: int.primaryKey(), title: text, done: boolean },
})

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const functions = {
  listTodos: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.todos).all()),
  addTodo: wy.procedure.input({ title: text }).mutation(async (ctx, args) => {
    return ctx.db.into(schema.todos).insert({ title: args.title, done: false })
  }),
}
type Functions = typeof functions

async function makeApp() {
  const pg = new PGlite()
  const db = drizzle(pg)
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  return wy.build({ db, functions })
}

/**
 * Wire the reactive tier the way `createRoutes` does: one store, one router,
 * both bound to the APP's source. The recompute re-runs the watched query so a
 * real subscription's `tablesWatched` recomputes exactly as it would live.
 */
function wireReactive(app: Awaited<ReturnType<typeof makeApp>>) {
  const store = createInMemorySubscriptionStore()
  createInvalidationRouter({
    source: app.invalidationSource,
    store,
    recompute: async (entry) => {
      const { tablesRead } = await app.call(
        entry.functionPath,
        entry.args,
        entry.context as Record<string, unknown>,
      )
      return { tablesRead }
    },
  })
  return store
}

/** A live subscription to `listTodos` watching the `todos` table, with a send spy. */
function subscribeListTodos(store: ReturnType<typeof wireReactive>) {
  const delivered: unknown[] = []
  const entry: SubscriptionEntry = {
    id: 'sub-1',
    functionPath: 'listTodos',
    args: {},
    tablesWatched: new Set(['todos']),
    send: (payload) => delivered.push(payload),
  }
  store.add(entry)
  return delivered
}

/**
 * Poll until `cond` holds or the deadline passes. Real timers, not microtask
 * flushing: the router's recompute here runs an actual PGlite query, so the
 * fan-out settles over real event-loop turns, not a fixed microtask count.
 */
async function until(cond: () => boolean, deadlineMs = 2000): Promise<boolean> {
  const start = performance.now()
  while (performance.now() - start < deadlineMs) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return cond()
}

/** Let any (incorrectly) pending fan-out drain, for asserting a NON-event. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 100))
}

describe('cross-surface invalidation (two-instance-bug regression)', () => {
  test('a write via createCaller (REST path) invalidates a live subscription', async () => {
    const app = await makeApp()
    const store = wireReactive(app)
    const delivered = subscribeListTodos(store)

    // Drive the mutation exactly as a REST route does: the typed caller, bound to
    // one request's context. No manual emit, no WS engine.
    const caller = createCaller<Functions>(app, { userId: 'user-1' })
    await caller.addTodo({ title: 'buy milk' })

    // The subscription received an invalidate — the write reached it through the
    // app's one fused source.
    expect(await until(() => delivered.length === 1)).toBe(true)
  })

  test('a write via raw app.call invalidates a live subscription', async () => {
    const app = await makeApp()
    const store = wireReactive(app)
    const delivered = subscribeListTodos(store)

    await app.call('addTodo', { title: 'walk dog' }, {})

    expect(await until(() => delivered.length === 1)).toBe(true)
  })

  test('a read via createCaller does NOT invalidate (no recompute storm)', async () => {
    const app = await makeApp()
    const store = wireReactive(app)
    const delivered = subscribeListTodos(store)

    // A pure query writes nothing → tablesWritten is empty → no emit. This is the
    // guard that the router's own recompute (which re-runs queries) can't loop.
    const caller = createCaller<Functions>(app, {})
    await caller.listTodos({})
    await settle()

    expect(delivered.length).toBe(0)
  })

  test('two apps do NOT cross-invalidate (the bug, reproduced and contained)', async () => {
    // Prove the diagnosis: separate app instances have separate sources. A write
    // on appB must NOT reach appA's subscription. This is exactly the split the
    // process collapse removes — here it documents WHY one instance is required.
    const appA = await makeApp()
    const appB = await makeApp()
    const storeA = wireReactive(appA)
    const deliveredA = subscribeListTodos(storeA)

    await createCaller<Functions>(appB, {}).addTodo({ title: 'other app' })
    await settle()

    expect(deliveredA.length).toBe(0)
  })
})
