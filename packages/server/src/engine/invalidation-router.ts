/**
 * @wystack/server — InvalidationRouter
 *
 * The InvalidationRouter connects an InvalidationSource to a SubscriptionStore:
 * when a write-event arrives (via `source.onInvalidation`), the router:
 *   1. Finds every SubscriptionEntry whose `tablesWatched` intersects the
 *      written tables.
 *   2. Re-runs the query (`recompute`) using the entry's captured context —
 *      never calling `resolveContext` again — to get the fresh `tablesRead`.
 *   3. Updates `entry.tablesWatched` in place.
 *   4. Calls `entry.send({ type: 'invalidate', id: entry.id })` so the client
 *      can refetch.
 *
 * Register exactly ONE router per shared (store, source) pair. Registering
 * one per connection would fan-out N frames per affected subscription per
 * mutation when N connections are open (the "double-fan trap"). The single
 * registration should live at the level that creates the store and source —
 * `createRoutes` for the Hono adapter, or the loopback harness for tests.
 *
 * `recompute(entry)` is deliberately narrow: it takes the whole entry so
 * callers can forward `entry.functionPath`, `entry.args`, and `entry.context`
 * without the router needing to know about `app.call`. This keeps the router
 * purely structural — transport-neutral and testable without a real `app`.
 *
 * Returns an unsubscribe function (mirrors the `InvalidationSource` contract).
 * Call it to stop routing invalidations (e.g. on server shutdown).
 */

import type { InvalidationSource } from './invalidation-source'
import type { SubscriptionStore, SubscriptionEntry } from './subscription-store'

export interface InvalidationRouterOptions {
  source: InvalidationSource
  store: SubscriptionStore
  /**
   * Re-run the query for a subscription using its captured context. Must NOT
   * call `resolveContext` — use `entry.context` as-is. Returns the updated
   * `tablesRead` set. May throw; on error, the entry's existing `tablesWatched`
   * is preserved and the client still receives the invalidate signal.
   */
  recompute: (entry: SubscriptionEntry) => Promise<{ tablesRead: Set<string> }>
}

export function createInvalidationRouter(opts: InvalidationRouterOptions): () => void {
  const { source, store, recompute } = opts

  return source.onInvalidation(async (tablesWritten) => {
    const affected = store.getAffected(tablesWritten)

    await Promise.allSettled(
      affected.map(async (entry) => {
        // Re-compute read-tags using the PRESERVED subscription-time context.
        // Any throw keeps the existing tablesWatched — the client will see the
        // error on its own refetch. Do not bail before calling entry.send.
        try {
          const { tablesRead } = await recompute(entry)
          entry.tablesWatched = tablesRead
        } catch {
          // Preserve existing tablesWatched on error.
        }

        // Deliver the invalidate signal. entry.send is a closure supplied by
        // the per-connection transport adapter; it is built to swallow
        // post-close sends (see engine.ts `send` helper).
        entry.send({ type: 'invalidate', id: entry.id })
      }),
    )
  })
}
