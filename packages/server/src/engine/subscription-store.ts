/**
 * @wystack/server — SubscriptionStore port.
 *
 * SubscriptionStore is the reactive tier's active-subscription registry. It is
 * deliberately transport-neutral: each entry carries the query metadata, its
 * mutable read-tag set, and a `send` callback supplied by the adapter. That
 * callback is the only delivery handle the engine needs, so serializing or
 * out-of-process engines never import Hono `WSContext` or any other transport
 * type.
 *
 * Serializing implementations must preserve the same logical contract across
 * process boundaries: entries are keyed by subscription id, `tablesWatched`
 * names the current read tags for invalidation matching, and `send` delivers a
 * server payload to the client associated with that id. Implementations may
 * persist or shard entries, but `getAffected(writtenTables)` must return every
 * live entry whose read-tag set intersects the provided write-tag set.
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
  add(entry: SubscriptionEntry): void
  remove(id: string): void
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
