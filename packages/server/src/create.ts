/**
 * createWyStack — the main entry point that wires schema, functions,
 * and database together into a running app.
 */
import { createTrackedDb } from '@wystack/db'
import type { FunctionDef, FunctionContext } from './types'
import { createSubscriptionManager } from './subscriptions'

type DrizzleDb = Parameters<typeof createTrackedDb>[0]

export interface WyStackApp {
  functions: Map<string, FunctionDef>
  subscriptions: ReturnType<typeof createSubscriptionManager>
  call: (path: string, args: any) => Promise<{ result: any; tablesRead: Set<string>; tablesWritten: Set<string> }>
}

export function createWyStack(opts: {
  drizzle: DrizzleDb
  functions: Record<string, FunctionDef>
}): WyStackApp {
  const functions = new Map<string, FunctionDef>()
  const subscriptions = createSubscriptionManager()

  for (const [path, def] of Object.entries(opts.functions)) {
    def.path = path
    functions.set(path, def)
  }

  const app: WyStackApp = {
    functions,
    subscriptions,

    async call(path: string, args: any) {
      const fn = functions.get(path)
      if (!fn) throw new Error(`Unknown function: ${path}`)

      // Create a fresh TrackedDb per call to avoid race conditions
      const tracked = createTrackedDb(opts.drizzle)
      const ctx: FunctionContext = { db: tracked }
      const result = await fn.handler(ctx, args)

      return {
        result,
        tablesRead: tracked.tablesRead,
        tablesWritten: tracked.tablesWritten,
      }
    },
  }

  return app
}
