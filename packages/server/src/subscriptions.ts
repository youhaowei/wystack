/**
 * Subscription Manager — tracks active WebSocket subscriptions and their
 * table dependencies so mutations can invalidate the right queries.
 */

export interface Subscription {
  id: string
  functionPath: string
  args: unknown
  /** Auth context at subscription time — used for invalidation re-queries */
  context?: Record<string, unknown>
  tablesWatched: Set<string>
}

export function createSubscriptionManager() {
  const subscriptions = new Map<string, Subscription>()

  return {
    add(sub: Subscription) {
      subscriptions.set(sub.id, sub)
    },

    remove(id: string) {
      subscriptions.delete(id)
    },

    get(id: string) {
      return subscriptions.get(id)
    },

    /** Find all subscriptions that watch any of the given tables */
    getAffectedSubscriptions(writtenTables: Set<string>): Subscription[] {
      const affected: Subscription[] = []
      for (const sub of subscriptions.values()) {
        for (const table of writtenTables) {
          if (sub.tablesWatched.has(table)) {
            affected.push(sub)
            break
          }
        }
      }
      return affected
    },

    size() {
      return subscriptions.size
    },

    clear() {
      subscriptions.clear()
    },
  }
}
