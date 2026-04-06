/**
 * createWyStack — the main entry point that wires DB, functions, and
 * reactive subscriptions together into a running app.
 */
import { createTrackedDb, createDb } from '@wystack/db'
import type { DbConfig } from '@wystack/db'
import type { FunctionDef, FunctionContext, DbInput } from './types'
import { createSubscriptionManager } from './subscriptions'
import { buildArgsSchema, ValidationError } from './validation'

export interface WyStackApp {
  functions: Map<string, FunctionDef>
  subscriptions: ReturnType<typeof createSubscriptionManager>
  /** Internal dispatch — resolves DB, creates TrackedDb, runs handler with context */
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

export async function createWyStack(opts: {
  db: DbInput
  dialect?: 'postgres'
  functions: Record<string, FunctionDef>
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

  const app: WyStackApp = {
    functions,
    subscriptions,

    async call(path: string, args: unknown, context: Record<string, unknown> = {}) {
      const fn = functions.get(path)
      if (!fn) throw new Error(`Unknown function: ${path}`)

      // Validate args against the cached Zod schema — produces validated + stripped output
      const schema = argsSchemas.get(path)
      let validatedArgs = args
      if (schema) {
        const parsed = schema.safeParse(args)
        if (!parsed.success) throw new ValidationError(parsed.error.issues)
        validatedArgs = parsed.data
      }

      // Fresh TrackedDb per call — no shared mutable state
      const tracked = createTrackedDb(drizzleDb)
      const ctx: FunctionContext = { db: tracked, ...context }
      const result = await fn.handler(ctx, validatedArgs)

      return {
        result,
        tablesRead: tracked.tablesRead,
        tablesWritten: tracked.tablesWritten,
      }
    },
  }

  return app
}
