// Request-timescale pure dispatch.
//
// `dispatch` is intentionally decoupled from all connection state — it takes
// a registry snapshot, a path, args, and a resolved context and returns the
// call result + tracking metadata. Both HTTP handlers and the Session (WS
// message transport) invoke it through this single chokepoint.
//
// The function registry and Zod validators live on WyStackApp (create.ts).
// Dispatch does not rebuild them — it reads them at call time.

import type { WyStackApp } from '../create'

export interface DispatchResult {
  result: unknown
  tablesRead: Set<string>
  tablesWritten: Set<string>
}

export async function dispatch(
  app: WyStackApp,
  path: string,
  args: unknown,
  context: Record<string, unknown>,
): Promise<DispatchResult> {
  return app.call(path, args, context)
}
