// @wystack/server — Dispatch (request-timescale)
//
// Dispatch is the request-timescale half of the Engine (Spec ADR #8). It is
// pure: given a function path, args, and a resolved context, it runs the
// function and returns the result plus the Tracker metadata. It holds no
// connection state, no auth state, no sockets — Session owns all of that.
//
// This is intentionally a thin wrapper over `WyStackApp.call`: validation,
// fresh-DrizzleTracker-per-call, and read/write tracking already live there
// (create.ts). Dispatch does not reimplement them — it names the seam so the
// Engine's transport adapters route through one pure entry point rather than
// reaching into `app.call` directly. When YW-62 wires the reactive tier, the
// invalidation source consumes `tablesWritten` from this same result.

import type { WyStackApp } from '../create'

/**
 * Result of a single dispatch. Mirrors `WyStackApp.call`'s return shape.
 *
 *   - `result` — the function's return value.
 *   - `tablesRead` — Tracker reads, consumed by the reactive tier to compute a
 *     subscription's watched-table set (YW-62; unused over plain RPC).
 *   - `tablesWritten` — Tracker writes, consumed by invalidation (YW-62; a
 *     `call` to a mutation produces this but plain RPC has no SubscriptionStore
 *     to feed, so the Engine drops it — see engine.ts).
 */
export interface DispatchResult {
  result: unknown
  tablesRead: Set<string>
  tablesWritten: Set<string>
}

/**
 * The pure dispatch function: `dispatch(path, args, context) -> result + tags`.
 * No side effects beyond running the registered handler against a fresh
 * DrizzleTracker. Throws what `app.call` throws — `Unknown function`,
 * `PermissionDeniedError`, `ValidationError`, or any handler error — for the
 * caller (Session/adapter) to map to the wire.
 */
export type Dispatch = (
  path: string,
  args: unknown,
  context: Record<string, unknown>,
) => Promise<DispatchResult>

/**
 * Build a pure `Dispatch` bound to an app's function registry. The registry is
 * the single source of truth for query vs mutation (Spec ADR #9) — Dispatch
 * does not distinguish the two; it runs whatever `path` resolves to.
 */
export function createDispatch(app: WyStackApp): Dispatch {
  return (path, args, context) => app.call(path, args, context)
}
