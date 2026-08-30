/** Wires DB, functions, and reactive subscriptions into a running app. */
import { createDrizzleTracker, createDb } from '@wystack/db'
import type {
  DbConfig,
  DrizzleTracker,
  DraftDrizzleTracker,
  MultiTenantDescriptor,
  TenantKeyDefinition,
} from '@wystack/db'
import { evaluate, type Permission } from '@wystack/permissions'
import {
  procedureInsertMethods,
  procedureSelectChainedMethods,
  procedureSelectTerminalMethods,
  type FunctionDef,
  type FunctionContext,
  type RawFunctionContext,
  type RawProcedureDb,
  type CommandDb,
  type DbInput,
  type ProcedureDb,
} from './types'
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
   * of a fresh per-call one. The handler receives a database facade, not the
   * tracker itself. This is the seam `applyCommands` uses to dispatch every
   * command in a batch through one native transaction and one merged Tag-set.
   * Native handlers receive the restricted facade (commands are typed to its
   * transaction-free `CommandDb` subset); explicitly branded raw boundaries
   * receive `RawProcedureDb` for canonical dispatch and are rejected by every
   * command/draft entry point before replay.
   *
   * Validation runs inside the composed handler after middleware exactly as in
   * `call`, so a batch command and a plain RPC to the same path validate identically. The
   * caller owns the DrizzleTracker lifecycle (creation, transaction, tracking-set
   * collection); this method injects runtime context and invokes the composed
   * handler with `{ ...context, db: procedureFacade, can }`, which then validates
   * args. Native procedures never receive raw SQL or tracking custody; neither
   * facade exposes tenant/draft scope changes.
   *
   * Calling it directly bypasses the transaction envelope, so the privileged
   * host caller is responsible for atomicity and invalidation.
   *
   * `tracked` may also be a `DraftDrizzleTracker` (a `base.withDraft(draftId)` handle):
   * this is the seam the draft lifecycle's `append` uses to route an UNMODIFIED
   * command handler's writes (`ctx.db.into/update/delete`) into the durable
   * draft overlay. `runHandler` converts either tracker to the same native
   * `from`/`into` surface, so the substitution is transparent to command
   * handlers while raw SQL, scope changes, and tracking sets remain framework
   * custody.
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
  const facade: Record<string, (...args: unknown[]) => unknown> = {}
  for (const method of procedureSelectChainedMethods) facade[method] = chained(method)
  for (const method of procedureSelectTerminalMethods) {
    facade[method] = (...args: unknown[]) => invokeBuilder(source, method, args)
  }
  return Object.freeze(facade)
}

function toProcedureInsertBuilder(source: object): object {
  const facade: Record<string, (...args: unknown[]) => unknown> = {}
  for (const method of procedureInsertMethods) {
    facade[method] = (...args: unknown[]) => invokeBuilder(source, method, args)
  }
  return Object.freeze(facade)
}

function toCommandDb(tracked: DrizzleTracker | DraftDrizzleTracker): CommandDb {
  return Object.freeze({
    from: ((table: Parameters<DrizzleTracker['from']>[0]) =>
      toProcedureSelectBuilder(tracked.from(table))) as CommandDb['from'],
    into: ((table: Parameters<DrizzleTracker['into']>[0]) =>
      toProcedureInsertBuilder(tracked.into(table))) as CommandDb['into'],
  })
}

function toProcedureDb(tracked: DrizzleTracker | DraftDrizzleTracker): ProcedureDb {
  const commandDb = toCommandDb(tracked)
  return Object.freeze({
    ...commandDb,
    transaction: async <R>(
      fn: (tx: ProcedureDb) => Promise<R>,
      opts?: Parameters<ProcedureDb['transaction']>[1],
    ) => tracked.transaction((tx) => fn(toProcedureDb(tx)), opts),
  })
}

function mappedTrackingSet(target: Set<string>, qualify: (tag: string) => string): Set<string> {
  let facade: Set<string>
  facade = new Proxy(target, {
    get(source, property) {
      if (property === 'add') {
        return (tag: string) => {
          source.add(qualify(tag))
          return facade
        }
      }
      if (property === 'forEach') {
        return (
          callback: (value: string, key: string, set: Set<string>) => void,
          thisArg?: unknown,
        ) =>
          source.forEach((value, key) => {
            callback.call(thisArg, value, key, facade)
          })
      }
      if (property === 'has') return (tag: string) => source.has(qualify(tag))
      if (property === 'delete') return (tag: string) => source.delete(qualify(tag))
      const value = Reflect.get(source, property, source)
      return typeof value === 'function' ? value.bind(source) : value
    },
  })
  return facade
}

function toRawProcedureDb(
  tracked: DrizzleTracker | DraftDrizzleTracker,
  qualifyTag: (tag: string) => string,
): RawProcedureDb {
  const assertGlobalTag = (tag: string) => {
    if (tag.startsWith('tenant:') || tag.startsWith('draft:')) {
      throw new Error(
        `Global tracking tag "${tag}" uses a reserved tenant or draft identity prefix`,
      )
    }
  }
  return Object.freeze({
    raw: tracked.raw,
    tablesRead: mappedTrackingSet(tracked.tablesRead, qualifyTag),
    tablesWritten: mappedTrackingSet(tracked.tablesWritten, qualifyTag),
    trackGlobalRead: (tag: string) => {
      assertGlobalTag(tag)
      tracked.tablesRead.add(tag)
    },
    trackGlobalWrite: (tag: string) => {
      assertGlobalTag(tag)
      tracked.tablesWritten.add(tag)
    },
    from: ((table: Parameters<DrizzleTracker['from']>[0]) =>
      toProcedureSelectBuilder(tracked.from(table))) as RawProcedureDb['from'],
    into: ((table: Parameters<DrizzleTracker['into']>[0]) =>
      toProcedureInsertBuilder(tracked.into(table))) as RawProcedureDb['into'],
    transaction: async <R>(
      fn: (tx: RawProcedureDb) => Promise<R>,
      opts?: Parameters<RawProcedureDb['transaction']>[1],
    ) => tracked.transaction((tx) => fn(toRawProcedureDb(tx, qualifyTag)), opts),
  })
}

export async function buildWyStack(opts: {
  db: DbInput
  dialect?: 'postgres'
  functions: Record<string, FunctionDef>
  permissions: unknown
  expectedPermissionIds?: readonly string[]
  tenancy?: MultiTenantDescriptor<TenantKeyDefinition>
  resolveTenant?: (context: Record<string, unknown>) => unknown | Promise<unknown>
}): Promise<WyStackApp> {
  if ((opts.tenancy === undefined) !== (opts.resolveTenant === undefined)) {
    throw new Error('buildWyStack requires tenancy and resolveTenant together')
  }
  if (opts.expectedPermissionIds) {
    assertPermissionIds(opts.permissions, opts.expectedPermissionIds)
  }

  const functions = new Map<string, FunctionDef>()
  const subscriptions = createSubscriptionManager()
  // The app owns the one invalidation source. `call` emits on it after a write;
  // transports wire their router to `app.invalidationSource` rather than minting
  // their own — see the WyStackApp.invalidationSource contract.
  const invalidation = createDispatchInvalidationSource()

  function qualifyRawTag(tracked: DrizzleTracker | DraftDrizzleTracker, tag: string): string {
    const tenantId = 'tenantId' in tracked ? tracked.tenantId : undefined
    if (tenantId === undefined || !opts.tenancy) return tag
    const tenantKey = encodeURIComponent(String(opts.tenancy.canonicalize(tenantId)))
    const prefix = `tenant:${tenantKey}:`
    return tag.startsWith(prefix) ? tag : `${prefix}${tag}`
  }

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

  async function runDefinition(
    fn: FunctionDef,
    path: string,
    args: unknown,
    tracked: DrizzleTracker | DraftDrizzleTracker,
    context: Record<string, unknown>,
  ): Promise<unknown> {
    // Native handlers receive only their declared database capability.
    // Replay-safe commands omit transaction at runtime as well as in their
    // CommandDb type because command application and draft replay own the
    // outer transaction. Raw SQL and scope-changing methods are unavailable
    // in both type and runtime.
    // Explicit raw boundaries restore raw Drizzle + manual Tag tracking
    // without restoring withTenant()/withDraft() custody.
    const databaseAccess: unknown = fn.databaseAccess
    let db: ProcedureDb | CommandDb | RawProcedureDb
    switch (databaseAccess) {
      case 'native':
        db =
          fn.type === 'mutation' && fn.draftReplayable === true
            ? toCommandDb(tracked)
            : toProcedureDb(tracked)
        break
      case 'read-model-raw':
      case 'integration-raw':
      case 'legacy-raw':
        db = toRawProcedureDb(tracked, (tag) => qualifyRawTag(tracked, tag))
        break
      default:
        throw new Error(
          `Function "${path}" has unsupported databaseAccess; expected "native", ` +
            `"read-model-raw", "integration-raw", or "legacy-raw"`,
        )
    }
    const ctx = { ...context, db } as FunctionContext | RawFunctionContext
    // oxlint-disable-next-line typescript/no-explicit-any -- ctx.can accepts app-specific permission contexts
    ctx.can = (permission: Permission<any>) => evaluate(ctx.principal, permission, ctx)
    return fn.handler(ctx, args)
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
      if (tenantId === null || tenantId === undefined) {
        throw new Error('withTenant() requires a non-null trusted tenant ID')
      }
      const tenancy = opts.tenancy as MultiTenantDescriptor<TenantKeyDefinition> & {
        canonicalize(value: unknown): unknown
      }
      return tracked.withTenant(tenancy.canonicalize(tenantId))
    },

    async runHandler(
      path: string,
      args: unknown,
      tracked: DrizzleTracker | DraftDrizzleTracker,
      context: Record<string, unknown> = {},
    ) {
      const fn = getFunction(path)
      return runDefinition(fn, path, args, tracked, context)
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
      const definition = getFunction(path)
      let result: unknown
      try {
        result =
          definition.type === 'mutation' && definition.draftReplayable === true
            ? await tracked.transaction((tx) => runDefinition(definition, path, args, tx, context))
            : await runDefinition(definition, path, args, tracked, context)
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
