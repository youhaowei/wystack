/** Wires DB, functions, and reactive subscriptions into a running app. */
import { createDrizzleTracker, createDb, ensureRowRevisionStorage } from '@wystack/db'
import type { DbConfig, DrizzleTracker, DraftDrizzleTracker } from '@wystack/db'
import { evaluate, type Permission } from '@wystack/permissions'
import type { FunctionDef, FunctionContext, DbInput, ProcedureDb } from './types'
import { assertPermissionIds } from './permissions'
import { createSubscriptionManager } from './subscriptions'
import {
  createDispatchInvalidationSource,
  type InvalidationSource,
} from './engine/invalidation-source'

/**
 * Explicit host-only capability for framework orchestration.
 *
 * This surface can mint trackers (and therefore reach raw SQL), change their
 * tenant scope, dispatch handlers against supplied trackers, and publish
 * invalidations. Application procedures never receive it. Keeping these seams
 * under a named, frozen capability makes privileged use visible at every call
 * site instead of presenting it as ordinary app behavior.
 */
export interface WyStackSystem {
  /**
   * Publish a write-tag set to the app's invalidation source. `call` invokes
   * this automatically after any dispatch that wrote. It is the explicit seam for the
   * runHandler-path writers that bypass `call` — `applyCommands`, draft `publish`,
   * direct `runHandler` — to flush their merged post-commit tag-set once the
   * transaction has durably committed. Fire-and-forget.
   */
  emit: (tablesWritten: Set<string>) => void
  /**
   * Run one registered function's handler using a SUPPLIED DrizzleTracker instead
   * of a fresh per-call one. The handler receives a `ProcedureDb`, not the tracker
   * itself. This is the seam `applyCommands` uses to dispatch every command in a
   * batch through one native transaction and one merged Tag-set.
   *
   * Validation runs inside the composed handler after middleware exactly as in
   * `call`, so a batch command and a plain RPC to the same path validate identically. The
   * caller owns the DrizzleTracker lifecycle (creation, transaction, tracking-set
   * collection); this method injects runtime context and invokes the composed
   * handler with `{ ...context, db: procedureFacade, can }`, which then validates
   * args without exposing raw SQL, scope changes, or tracking custody.
   *
   * Calling it directly bypasses the transaction envelope, so the privileged
   * host caller is responsible for atomicity and invalidation.
   *
   * `tracked` may also be a `DraftDrizzleTracker` (a `base.withDraft(draftId)` handle):
   * this is the seam the draft lifecycle's `append` uses to route an UNMODIFIED
   * command handler's writes (`ctx.db.into/update/delete`) into the durable
   * draft overlay. `runHandler` converts either tracker to the same restricted
   * `ProcedureDb` surface (`from`, `into`, and `transaction`), so the substitution
   * is transparent to handlers while raw SQL, scope changes, and tracking sets
   * remain framework custody.
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
   * This is privileged because a tracker also owns raw SQL and scope changes.
   */
  createTracked: () => DrizzleTracker
  /** Bind host-resolved tenant scope to a tracker for one request or batch. */
  scopeTracked: (
    tracked: DrizzleTracker,
    context?: Record<string, unknown>,
  ) => Promise<DrizzleTracker>
  /**
   * Whether the host installed `resolveTenant`. When false the app has no tenant
   * dimension: `scopeTracked` is the identity and an unscoped tracker is the
   * only scope there is, not a privileged one.
   */
  readonly resolvesTenant: boolean
}

export interface WyStackApp {
  functions: Map<string, FunctionDef>
  subscriptions: ReturnType<typeof createSubscriptionManager>
  /**
   * The app's single invalidation source. Every write dispatched through `call`,
   * and every explicit `system.emit`, fans out on this one source. Transports wire
   * their `InvalidationRouter` to it — they must NOT create their own source, or a
   * write on one surface (REST) would be invisible to subscriptions served by
   * another (WS). One app instance ⇒ one source ⇒ one live reactive tier.
   */
  invalidationSource: InvalidationSource
  /** Host-only framework orchestration. Never pass this capability to procedures. */
  readonly system: Readonly<WyStackSystem>
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
  await ensureRowRevisionStorage(drizzleDb)

  for (const [path, def] of Object.entries(opts.functions)) {
    def.path = path
    functions.set(path, def)
  }

  function getFunction(path: string) {
    const fn = functions.get(path)
    if (!fn) throw new Error(`Unknown function: ${path}`)
    return fn
  }

  const system: WyStackSystem = Object.freeze({
    emit: invalidation.emit,
    resolvesTenant: opts.resolveTenant !== undefined,

    createTracked() {
      return createDrizzleTracker(drizzleDb)
    },

    async scopeTracked(tracked: DrizzleTracker, context = {}) {
      if (!opts.resolveTenant) return tracked
      const tenantId = await opts.resolveTenant(context)
      return tracked.withTenant(tenantId)
    },

    async runHandler(
      path: string,
      args: unknown,
      tracked: DrizzleTracker | DraftDrizzleTracker,
      context: Record<string, unknown> = {},
    ) {
      const fn = getFunction(path)
      // Handlers receive only the restricted ProcedureDb surface. A
      // draft tracker implements transaction() as a fail-loud nested-transaction
      // guard because lifecycle append/publish own the outer boundaries. Raw SQL
      // and scope-changing methods are unavailable in both type and runtime.
      const ctx = { ...context, db: toProcedureDb(tracked) } as FunctionContext
      // oxlint-disable-next-line typescript/no-explicit-any -- ctx.can accepts app-specific permission contexts
      ctx.can = (permission: Permission<any>) => evaluate(ctx.principal, permission, ctx)
      return fn.handler(ctx, args)
    },
  })

  const app: WyStackApp = {
    functions,
    subscriptions,
    invalidationSource: invalidation.source,
    system,

    async call(path: string, args: unknown, context: Record<string, unknown> = {}) {
      // Fresh DrizzleTracker per call — no shared mutable state
      const tracked = await system.scopeTracked(system.createTracked(), context)
      let result: unknown
      try {
        result = await system.runHandler(path, args, tracked, context)
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
  }

  return app
}
