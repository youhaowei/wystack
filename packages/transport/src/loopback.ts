// @wystack/transport — in-memory loopback adapter
//
// `createLoopbackPair` returns two `Pipe`s wired to each other: `a.send(x)`
// delivers to handlers on `b`, and vice versa. Delivery is asynchronous
// (`queueMicrotask`) so a handler is never invoked synchronously inside the
// caller's `send` — that property matches every real adapter (WS, IPC) and
// prevents tests from depending on synchronous re-entry that production
// pipes cannot reproduce.
//
// Salvaged concept from PR #15 (TASK-548), rebuilt against the real Pipe
// interface so engine tests can exercise the full subscription/invalidation
// path without spinning up a WebSocket server.

import type { Pipe } from './pipe'

type Handler<T> = (message: T) => void

interface LoopbackEnd<In, Out> {
  readonly id: string
  readonly handlers: Set<Handler<In>>
  closed: boolean
  partner: LoopbackEnd<Out, In> | null
}

/**
 * Bidirectional in-memory pipe pair.
 *
 * Returns `[Pipe<A, B>, Pipe<B, A>]`:
 *   - First pipe receives `A`, sends `B`. Its `send(B)` reaches the second
 *     pipe's `onMessage` handler (which receives `B`).
 *   - Second pipe receives `B`, sends `A`. Its `send(A)` reaches the first
 *     pipe's `onMessage` handler (which receives `A`).
 *
 * Defaults are `unknown` for both type params so tests can instantiate the
 * pair without committing to a wire shape.
 */
export function createLoopbackPair<A = unknown, B = unknown>(): [Pipe<A, B>, Pipe<B, A>] {
  const pairId = generatePairId()

  // endA: receives A, sends B. endB: receives B, sends A.
  const endA: LoopbackEnd<A, B> = {
    id: `loopback-${pairId}-a`,
    handlers: new Set(),
    closed: false,
    partner: null,
  }
  const endB: LoopbackEnd<B, A> = {
    id: `loopback-${pairId}-b`,
    handlers: new Set(),
    closed: false,
    partner: null,
  }
  endA.partner = endB
  endB.partner = endA

  return [makePipe(endA), makePipe(endB)]
}

function makePipe<In, Out>(self: LoopbackEnd<In, Out>): Pipe<In, Out> {
  return {
    get id() {
      return self.id
    },
    send(message: Out): void {
      // After close (locally or via partner closing us), drop silently.
      if (self.closed) return
      const partner = self.partner
      if (partner === null || partner.closed) return
      // Snapshot handlers so a handler that mutates the set during delivery
      // does not affect this batch's recipients. queueMicrotask gives us the
      // async-boundary guarantee real adapters provide.
      const recipients = Array.from(partner.handlers)
      queueMicrotask(() => {
        // Re-check on the microtask: partner may have closed between the
        // schedule and the run.
        if (partner.closed) return
        for (const handler of recipients) {
          // Only deliver if the handler is still subscribed. A handler that
          // unsubscribed between scheduling and running should not fire.
          if (!partner.handlers.has(handler)) continue
          try {
            handler(message)
          } catch (error) {
            queueMicrotask(() => {
              throw error
            })
          }
        }
      })
    },
    onMessage(handler: (message: In) => void): () => void {
      if (self.closed) return () => {}
      self.handlers.add(handler)
      return () => {
        self.handlers.delete(handler)
      }
    },
    close(): void {
      // Idempotent. Flip our flag first so a partner notification that
      // re-enters our close (or our send) sees a closed pipe.
      if (self.closed) return
      self.closed = true
      self.handlers.clear()
      const partner = self.partner
      // Bidirectional teardown: closing one end closes the other. Each end
      // checks its own flag first, so the mutual call terminates after one
      // hop.
      if (partner !== null && !partner.closed) {
        partner.closed = true
        partner.handlers.clear()
      }
    },
  }
}

// Pair identity — preferred path is `crypto.randomUUID`, but `crypto` may be
// absent in unusual runtime configs (older Node-without-globalThis, edge
// shims). Fall back to a counter + Math.random nibble; the id is for logs
// and correlation only, not security.
let pairCounter = 0
function generatePairId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (c !== undefined && typeof c.randomUUID === 'function') return c.randomUUID()
  pairCounter += 1
  return `${pairCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
