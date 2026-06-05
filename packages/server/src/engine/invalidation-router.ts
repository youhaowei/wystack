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
 * Per-sub serialization (YW-64): invalidations for the SAME subscription id
 * are processed in arrival order. Each sub maintains an independent "tail"
 * Promise; each new recompute is chained onto that tail, so same-sub
 * recomputes are strictly sequential while different subs remain concurrent.
 * The tail self-deletes when it drains (via `.finally`), so the map never
 * accumulates stale entries for removed subscriptions.
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

  // Per-subscription serialization queue.
  //
  // `tails` maps subscription id → the tail Promise of that sub's recompute
  // chain. Chaining is done SYNCHRONOUSLY inside the handler (before any
  // await), so two near-simultaneous invalidations are ordered by the first
  // synchronous pass through `getAffected` → chain-building — no interleaving.
  //
  // Each link in the chain is a `Promise<void>` that never rejects: errors
  // inside `processOne` are swallowed so the `.then` propagation never breaks
  // the chain and later recomputes always run.
  const tails = new Map<string, Promise<void>>()

  /**
   * Process a single subscription entry: re-query, update tablesWatched, send
   * the invalidate signal. Always resolves (never rejects) — errors are
   * isolated so the per-sub chain stays alive.
   */
  async function processOne(entry: SubscriptionEntry): Promise<void> {
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
    // post-close sends (see engine.ts `send` helper). Wrap in try/catch so a
    // misbehaving send implementation cannot break the chain.
    try {
      entry.send({ type: 'invalidate', id: entry.id })
    } catch {
      // send errors are swallowed — the chain must never reject.
    }
  }

  return source.onInvalidation((tablesWritten) => {
    const affected = store.getAffected(tablesWritten)

    // Build the per-sub chains SYNCHRONOUSLY — all tails are updated in this
    // same tick before yielding to the microtask queue. Two near-simultaneous
    // `onInvalidation` calls therefore produce a deterministic ordering.
    for (const entry of affected) {
      const id = entry.id
      const prev = tails.get(id) ?? Promise.resolve()

      // Chain this recompute after the previous one for this sub id.
      const next = prev.then(() => processOne(entry))
      tails.set(id, next)

      // Self-cleanup: when this link finishes and nothing newer has been
      // chained (i.e. `tails.get(id) === next`), remove the entry so the map
      // does not retain stale references for idle or removed subscriptions.
      void next.finally(() => {
        if (tails.get(id) === next) {
          tails.delete(id)
        }
      })
    }
  })
}
