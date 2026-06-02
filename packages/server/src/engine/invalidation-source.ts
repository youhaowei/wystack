/**
 * @wystack/server — InvalidationSource port.
 *
 * InvalidationSource is the reactive tier's write-event stream. Dispatch
 * produces a `tablesWritten` set after each mutation; the in-process default
 * exposes an `emit` helper for that dispatch path, while the engine consumes
 * only the `InvalidationSource` interface.
 *
 * Serializing implementations use the same contract over an external channel:
 * a producer publishes the set of table/write tags affected by a mutation, and
 * consumers invoke each registered handler once for that invalidation event.
 * For example, a Postgres LISTEN/NOTIFY adapter would deserialize the payload
 * into a `Set<string>` and pass it through `onInvalidation` handlers. Delivery
 * is fire-and-forget in this port; ordering, durability, and await-before-HTTP
 * response semantics belong to the implementation that wires the source.
 */

export type InvalidationHandler = (tablesWritten: Set<string>) => void

export interface InvalidationSource {
  onInvalidation(handler: InvalidationHandler): () => void
}

export interface DispatchInvalidationSource {
  source: InvalidationSource
  emit(tablesWritten: Set<string>): void
}

export function createDispatchInvalidationSource(): DispatchInvalidationSource {
  const handlers = new Set<InvalidationHandler>()

  return {
    source: {
      onInvalidation(handler) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    },

    emit(tablesWritten) {
      for (const handler of handlers) {
        handler(new Set(tablesWritten))
      }
    },
  }
}
