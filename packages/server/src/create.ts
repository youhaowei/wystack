/** Wires DB, functions, and reactive subscriptions into a running app. */
import { createDrizzleTracker, createDb } from '@wystack/db'
import type { DbConfig, DrizzleTracker, DraftDrizzleTracker } from '@wystack/db'
import { evaluate, type Permission } from '@wystack/permissions'
import type { FunctionDef, FunctionContext, DbInput } from './types'
import { assertPermissionIds } from './permissions'
import { createSubscriptionManager } from './subscriptions'
import {
  createDispatchInvalidationSource,
  type InvalidationSource,
} from './engine/invalidation-source'

export interface WyStackApp {
  functions: Map<string, FunctionDef>
  subscriptions: ReturnType<typeof createSubscriptionManager>
  /**
   * The app's single invalidation source. Every write dispatched through `call`,
   * and every explicit `emit`, fans out on this one source. Transports wire their
   * `InvalidationRouter` to it — they must NOT create their own source, or a
   * write on one surface (REST) would be invisible to subscriptions served by
   * another (WS). One app instance ⇒ one source ⇒ one live reactive tier.
   */
  invalidationSource: InvalidationSource
  /**
   * Publish a write-tag set to the app's invalidation source. `call` invokes this
   * automatically after any dispatch that wrote (guarded on `tablesWritten.size`),
   * so plain RPC/REST callers never need to. It is the explicit seam for the
   * runHandler-path writers that bypass `call` — `applyCommands`, draft `publish`,
   * direct `runHandler` — to flush their merged post-commit tag-set once the
   * transaction has durably committed. Fire-and-forget.
   */
  emit: (tablesWritten: Set<string>) => void
  /** Internal dispatch — resolves DB, creates DrizzleTracker, runs handler with context */
  call: (
    path: string,
    args: unknown,
    context?: Record<string, unknown>,
  ) => Promise<{
    result: unknown
    tablesRead: Set<string>
    tablesWritten: Set<string>
  }>
  /**
   * Run one registered function's handler against a SUPPLIED DrizzleTracker instead
   * of a fresh per-call one. This is the seam `applyCommands` uses to dispatch
   * every command in a batch through the same tx-bound tracker, so their writes
   * land in one native transaction and one merged Tag-set.
   *
   * Validation runs inside the composed handler after middleware exactly as in
   * `call`, so a batch command and a plain RPC to the same path validate identically. The
   * caller owns the DrizzleTracker lifecycle (creation, transaction, tracking-set
   * collection); this method injects runtime context and invokes the composed
   * handler with `{ ...context, db: tracked, can }`, which then validates args.
   *
   * This is a LOW-LEVEL escape hatch, reachable on the exported `WyStackApp`
   * type but not part of the intended public API — prefer `applyCommands` or
   * `call`. Calling it directly bypasses the transaction envelope, so the
   * caller is responsible for atomicity and invalidation. It exists so the
   * in-package `applyCommands` engine can dispatch a handler against a supplied
   * tx-bound tracker; external use is unsupported and may change.
   *
   * `tracked` may also be a `DraftDrizzleTracker` (a `base.withDraft(draftId)` handle):
   * this is the seam the draft lifecycle's `append` uses to route an UNMODIFIED
   * command handler's writes (`ctx.db.into/update/delete`) into the
   * `<table>__draft` overlay. Handlers are authored against `DrizzleTracker` and only
   * touch the from/into/where/all/insert/update/delete surface both handles
   * share — so the substitution is transparent to them.
   */
  runHandler: (
    path: string,
    args: unknown,
    tracked: DrizzleTracker | DraftDrizzleTracker,
    context?: Record<string, unknown>,
  ) => Promise<unknown>
  /**
   * Mint a fresh DrizzleTracker bound to this app's connection, with empty tracking
   * sets. The seam `applyCommands` uses to obtain an OUTER tracker whose
   * `.transaction(...)` opens one native transaction for a whole command batch.
   * Equivalent to the fresh-per-call tracker `call` builds internally, exposed
   * so the batch engine can own the transaction lifecycle.
   *
   * Low-level escape hatch like `runHandler` — reachable on the exported type
   * but not the intended public API; prefer `applyCommands`/`call`.
   */
  createTracked: () => DrizzleTracker
}

function resolveDbConfig(db: DbInput): DbConfig | null {
  if (typeof db === 'string') {
    if (db.startsWith('pglite://')) return { dev: db }
    return { url: db }
  }
  if ('dev' in db || 'prod' in db || 'url' in db) return db as DbConfig
  return null // Pre-built Drizzle instance
}

export async function buildWyStack(opts: {
  db: DbInput
  dialect?: 'postgres'
  functions: Record<string, FunctionDef>
  permissions: unknown
  expectedPermissionIds?: readonly string[]
}): Promise<WyStackApp> {
  if (opts.expectedPermissionIds) {
    assertPermissionIds(opts.permissions, opts.expectedPermissionIds)
  }

  const functions = new Map<string, FunctionDef>()
  const subscriptions = createSubscriptionManager()
  // The app owns the one invalidation source. `call` emits on it after a write;
  // transports wire their router to `app.invalidationSource` rather than minting
  // their own — see the WyStackApp.invalidationSource contract.
  const invalidation = createDispatchInvalidationSource()

  // Resolve DB: either use createDb for config, or treat as raw Drizzle instance
  const dbConfig = resolveDbConfig(opts.db)
  const drizzleDb = dbConfig ? await createDb(dbConfig) : opts.db

  for (const [path, def] of Object.entries(opts.functions)) {
    def.path = path
    functions.set(path, def)
  }

  function getFunction(path: string) {
    const fn = functions.get(path)
    if (!fn) throw new Error(`Unknown function: ${path}`)
    return fn
  }

  const app: WyStackApp = {
    functions,
    subscriptions,
    invalidationSource: invalidation.source,
    emit: invalidation.emit,

    createTracked() {
      return createDrizzleTracker(drizzleDb)
    },

    async call(path: string, args: unknown, context: Record<string, unknown> = {}) {
      // Fresh DrizzleTracker per call — no shared mutable state
      const tracked = app.createTracked()
      const result = await app.runHandler(path, args, tracked, context)

      // Fuse: any write dispatched through `call` fans out on the app's source,
      // so REST, WS call-frames, and the typed caller all invalidate without the
      // transport re-emitting. Guarded on write count so a read-only call — most
      // importantly the router's subscription recompute, which re-runs queries —
      // never emits, and there is no recompute storm.
      if (tracked.tablesWritten.size > 0) invalidation.emit(tracked.tablesWritten)

      return {
        result,
        tablesRead: tracked.tablesRead,
        tablesWritten: tracked.tablesWritten,
      }
    },

    async runHandler(
      path: string,
      args: unknown,
      tracked: DrizzleTracker | DraftDrizzleTracker,
      context: Record<string, unknown> = {},
    ) {
      const fn = getFunction(path)
      // A DraftDrizzleTracker shares the from/into/where/all/insert/update/delete
      // surface handlers use; the cast bridges the structural difference in
      // builder return types (DraftSelectBuilder vs SelectBuilder) that handlers
      // never observe. The draft handle has no `transaction` (publish owns the
      // atomic boundary), which a command handler must not call directly.
      const ctx = { ...context, db: tracked as DrizzleTracker } as FunctionContext
      // oxlint-disable-next-line typescript/no-explicit-any -- ctx.can accepts app-specific permission contexts
      ctx.can = (permission: Permission<any>) => evaluate(ctx.principal, permission, ctx)
      return fn.handler(ctx, args)
    },
  }

  return app
}
