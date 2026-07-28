/**
 * @wystack/server — SubscriptionStore port.
 *
 * SubscriptionStore is the reactive tier's active-subscription registry. It is
 * deliberately transport-neutral: each entry carries the query metadata, its
 * mutable read-tag set, and a `send` callback supplied by the adapter. That
 * callback is the only delivery handle the engine needs, so the engine never
 * imports Hono `WSContext` or any other transport type.
 *
 * This store is node-local by construction because `send` is a process-local
 * closure over a live client connection. In a distributed deployment, each node
 * keeps its own SubscriptionStore for its own sockets and subscribes to the
 * shared InvalidationSource. Implementations must preserve the local contract:
 * entries are keyed by subscription id, `tablesWatched` names the current read
 * tags for invalidation matching, and `getAffected(writtenTables)` returns
 * every live entry whose read-tag set intersects the provided write-tag set.
 */

export interface SubscriptionEntry {
  id: string
  functionPath: string
  args: unknown
  /** Auth context captured when the subscription was registered. */
  context?: Record<string, unknown>
  /** Mutable read-tag set; invalidation re-queries replace this in place. */
  tablesWatched: Set<string>
  /** Transport-supplied delivery hook for this subscription's client. */
  send: (payload: unknown) => void
}

export interface SubscriptionStore {
  /**
   * Register or replace an entry by id. Replacement is intentional: callers own
   * subscription ids and may re-register the same id during reconnect or
   * resubscribe flows without requiring a separate remove.
   */
  add(entry: SubscriptionEntry): void
  remove(id: string): void
  /**
   * MUST return the identical object instance previously returned by
   * `getAffected`/`add` for this id, never a copy or proxy: the invalidation
   * router compares `store.get(entry.id) !== entry` by reference identity
   * across an await to detect that an entry was removed or replaced, so any
   * implementation that hands back a distinct instance per call (e.g. a
   * distributed store that proxies or deserializes) breaks that check for
   * every live entry and silently drops every invalidation.
   */
  get(id: string): SubscriptionEntry | undefined
  getAffected(writtenTables: Set<string>): SubscriptionEntry[]
  size(): number
  clear(): void
}

export function createInMemorySubscriptionStore(): SubscriptionStore {
  const entries = new Map<string, SubscriptionEntry>()

  return {
    add(entry) {
      entries.set(entry.id, entry)
    },

    remove(id) {
      entries.delete(id)
    },

    get(id) {
      return entries.get(id)
    },

    getAffected(writtenTables) {
      const affected: SubscriptionEntry[] = []
      for (const entry of entries.values()) {
        for (const table of writtenTables) {
          if (entry.tablesWatched.has(table)) {
            affected.push(entry)
            break
          }
        }
      }
      return affected
    },

    size() {
      return entries.size
    },

    clear() {
      entries.clear()
    },
  }
}
