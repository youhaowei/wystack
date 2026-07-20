/**
 * createWyStack — the main entry point that wires DB, functions, and
 * reactive subscriptions together into a running app.
 */
import { createDrizzleTracker, createDb } from '@wystack/db'
import type { DbConfig, DrizzleTracker, DraftDrizzleTracker } from '@wystack/db'
import type { FunctionDef, FunctionContext, DbInput } from './types'
import { assertFunctionPermission, type CheckPermission } from './permissions'
import { createSubscriptionManager } from './subscriptions'
import { buildArgsSchema, ValidationError } from './validation'

export interface WyStackApp {
  functions: Map<string, FunctionDef>
  subscriptions: ReturnType<typeof createSubscriptionManager>
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
   * Validation (the cached Zod schema) runs here exactly as in `call`, so a
   * batch command and a plain RPC to the same path validate identically. The
   * caller owns the DrizzleTracker lifecycle (creation, transaction, tracking-set
   * collection); this method authorizes the function, validates its args, and
   * invokes the handler with `{ ...context, db: tracked }`.
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

export async function createWyStack(opts: {
  db: DbInput
  dialect?: 'postgres'
  functions: Record<string, FunctionDef>
  checkPermission?: CheckPermission
}): Promise<WyStackApp> {
  const functions = new Map<string, FunctionDef>()
  const subscriptions = createSubscriptionManager()

  // Resolve DB: either use createDb for config, or treat as raw Drizzle instance
  const dbConfig = resolveDbConfig(opts.db)
  const drizzleDb = dbConfig ? await createDb(dbConfig) : opts.db

  // Build and cache Zod schemas from ColumnDef arg descriptors
  const argsSchemas = new Map<string, ReturnType<typeof buildArgsSchema>>()
  for (const [path, def] of Object.entries(opts.functions)) {
    def.path = path
    argsSchemas.set(path, buildArgsSchema(def.args))
    functions.set(path, def)
  }

  // Validate args against the cached Zod schema — produces validated + stripped
  // output. Shared by `call` (fresh tracker) and `runHandler` (supplied tracker)
  // so a path validates identically however it is dispatched.
  function getFunction(path: string) {
    const fn = functions.get(path)
    if (!fn) throw new Error(`Unknown function: ${path}`)
    return fn
  }

  function validateArgs(path: string, args: unknown) {
    const schema = argsSchemas.get(path)
    let validatedArgs = args
    if (schema) {
      const parsed = schema.safeParse(args)
      if (!parsed.success) throw new ValidationError(parsed.error.issues)
      validatedArgs = parsed.data
    }
    return validatedArgs
  }

  const app: WyStackApp = {
    functions,
    subscriptions,

    createTracked() {
      return createDrizzleTracker(drizzleDb)
    },

    async call(path: string, args: unknown, context: Record<string, unknown> = {}) {
      // Fresh DrizzleTracker per call — no shared mutable state
      const tracked = app.createTracked()
      const result = await app.runHandler(path, args, tracked, context)

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
      await assertFunctionPermission(fn, context, opts.checkPermission)
      const validatedArgs = validateArgs(path, args)
      // A DraftDrizzleTracker shares the from/into/where/all/insert/update/delete
      // surface handlers use; the cast bridges the structural difference in
      // builder return types (DraftSelectBuilder vs SelectBuilder) that handlers
      // never observe. The draft handle has no `transaction` (publish owns the
      // atomic boundary), which a command handler must not call directly.
      const ctx: FunctionContext = { ...context, db: tracked as DrizzleTracker }
      return fn.handler(ctx, validatedArgs)
    },
  }

  return app
}
