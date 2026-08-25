/** Wires DB, functions, and reactive subscriptions into a running app. */
import { createDrizzleTracker, createDb } from '@wystack/db'
import type { DbConfig, DrizzleTracker, DraftDrizzleTracker } from '@wystack/db'
import { evaluate, type Permission } from '@wystack/permissions'
import type { FunctionDef, FunctionContext, DbInput, ProcedureDb } from './types'
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
   * command handler's writes (`ctx.db.into/update/delete`) into the durable
   * draft overlay. Handlers are authored against `DrizzleTracker` and only
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
  /** Bind host-resolved tenant scope to a tracker for one request or batch. */
  scopeTracked: (
    tracked: DrizzleTracker,
    context?: Record<string, unknown>,
  ) => Promise<DrizzleTracker>
}

function resolveDbConfig(db: DbInput): DbConfig | null {
  if (typeof db === 'string') {
    if (db.startsWith('pglite://')) return { dev: db }
    return { url: db }
  }
  if ('dev' in db || 'prod' in db || 'url' in db) return db as DbConfig
  return null // Pre-built Drizzle instance
}

function invokeBuilder(source: object, method: string, args: unknown[]): unknown {
  const candidate = Reflect.get(source, method)
  if (typeof candidate !== 'function') {
    throw new Error(`Procedure database builder does not support ${method}()`)
  }
  return Reflect.apply(candidate, source, args)
}

function toProcedureSelectBuilder(source: object): object {
  const chained =
    (method: string) =>
    (...args: unknown[]) =>
      toProcedureSelectBuilder(invokeBuilder(source, method, args) as object)
  return Object.freeze({
    select: chained('select'),
    where: chained('where'),
    orderBy: chained('orderBy'),
    limit: chained('limit'),
    all: (...args: unknown[]) => invokeBuilder(source, 'all', args),
    first: (...args: unknown[]) => invokeBuilder(source, 'first', args),
    update: (...args: unknown[]) => invokeBuilder(source, 'update', args),
    delete: (...args: unknown[]) => invokeBuilder(source, 'delete', args),
    toSql: (...args: unknown[]) => invokeBuilder(source, 'toSql', args),
  })
}

function toProcedureInsertBuilder(source: object): object {
  return Object.freeze({
    insert: (...args: unknown[]) => invokeBuilder(source, 'insert', args),
  })
}

function toProcedureDb(tracked: DrizzleTracker | DraftDrizzleTracker): ProcedureDb {
  return Object.freeze({
    from: ((table: Parameters<DrizzleTracker['from']>[0]) =>
      toProcedureSelectBuilder(tracked.from(table))) as ProcedureDb['from'],
    into: ((table: Parameters<DrizzleTracker['into']>[0]) =>
      toProcedureInsertBuilder(tracked.into(table))) as ProcedureDb['into'],
    transaction: async <R>(
      fn: (tx: ProcedureDb) => Promise<R>,
      opts?: Parameters<ProcedureDb['transaction']>[1],
    ) => tracked.transaction((tx) => fn(toProcedureDb(tx)), opts),
  })
}

export async function buildWyStack(opts: {
  db: DbInput
  dialect?: 'postgres'
  functions: Record<string, FunctionDef>
  permissions: unknown
  expectedPermissionIds?: readonly string[]
  resolveTenant?: (context: Record<string, unknown>) => unknown | Promise<unknown>
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

    async scopeTracked(tracked, context = {}) {
      if (!opts.resolveTenant) return tracked
      const tenantId = await opts.resolveTenant(context)
      return tracked.withTenant(tenantId)
    },

    async call(path: string, args: unknown, context: Record<string, unknown> = {}) {
      // Fresh DrizzleTracker per call — no shared mutable state
      const tracked = await app.scopeTracked(app.createTracked(), context)
      let result: unknown
      try {
        result = await app.runHandler(path, args, tracked, context)
      } finally {
        // Fuse: any COMMITTED tracked write dispatched through `call` fans out
        // on the app's source. The finally is load-bearing for Actions: a
        // handler may commit a DB write, then fail during later external I/O.
        // That durable write must still invalidate. Rolled-back transactions
        // merge no write Tags, so they emit nothing here.
        if (tracked.tablesWritten.size > 0) invalidation.emit(tracked.tablesWritten)
      }

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
      // Handlers receive only the tracked read/write/transaction surface. A
      // draft tracker implements transaction() as a fail-loud guard because
      // publish owns its atomic boundary; raw SQL and scope-changing methods are
      // intentionally unavailable in both the type and the runtime object.
      const ctx = { ...context, db: toProcedureDb(tracked) } as FunctionContext
      // oxlint-disable-next-line typescript/no-explicit-any -- ctx.can accepts app-specific permission contexts
      ctx.can = (permission: Permission<any>) => evaluate(ctx.principal, permission, ctx)
      return fn.handler(ctx, args)
    },
  }

  return app
}
