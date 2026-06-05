// Per-sub serialization queue tests — YW-64 / TASK-646 T10
//
// Drives the router in isolation (no Engine, no Pipe): custom recompute
// functions with controlled timing via deferred Promises.
//
// Red→green evidence:
//   - The race test (same-sub) FAILS on the old `Promise.allSettled` fan-out
//     because a later-resolving D2 clobbers with tables-v1.
//   - After per-sub serialization is added, it PASSES: recompute #2 is queued
//     behind #1, so D2's tables-v2 is always the final value.

import { describe, test, expect } from 'bun:test'
import { createInvalidationRouter } from '../engine/invalidation-router'
import { createDispatchInvalidationSource } from '../engine/invalidation-source'
import { createInMemorySubscriptionStore } from '../engine/subscription-store'
import type { SubscriptionEntry } from '../engine/subscription-store'

function makeEntry(
  id: string,
  tables: string[],
  sendFn?: (payload: unknown) => void,
): SubscriptionEntry {
  return {
    id,
    functionPath: 'testQuery',
    args: {},
    tablesWatched: new Set(tables),
    send: sendFn ?? (() => {}),
  }
}

/** Flush a few macrotask ticks — for asserting completions or non-events. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 30))
}

describe('InvalidationRouter — per-sub serialization queue (YW-64)', () => {
  // ---------------------------------------------------------------------------
  // Race test (the core AC): two invalidations for the SAME subscription with
  // controlled recompute timing. Resolving the deferreds in REVERSE order
  // demonstrates the race.
  //
  // Key insight:
  //   Old allSettled: both recomputes run concurrently.
  //     D2 resolves first → entry.tablesWatched = {tables-v2}
  //     D1 resolves second → entry.tablesWatched = {tables-v1}  ← CLOBBER (RED)
  //
  //   New serialized: recompute #2 waits until #1 completes.
  //     D1 resolves → #1 writes {tables-v1}; #2 starts, D2 already resolved
  //     → #2 writes {tables-v2}
  //     Final: {tables-v2} (GREEN)
  //
  // No deadlock: resolving D2 before D1 only means D2 is pre-resolved by the
  // time recompute #2 starts — `await` on an already-resolved promise is
  // a no-op (one microtask tick).
  // ---------------------------------------------------------------------------
  test('same-sub: later recompute always wins (reverse-resolve race)', async () => {
    const store = createInMemorySubscriptionStore()
    const { source, emit } = createDispatchInvalidationSource()

    let callCount = 0
    let resolveD1!: () => void
    let resolveD2!: () => void
    const D1 = new Promise<void>((r) => {
      resolveD1 = r
    })
    const D2 = new Promise<void>((r) => {
      resolveD2 = r
    })

    createInvalidationRouter({
      source,
      store,
      recompute: async (_entry) => {
        callCount++
        const myCall = callCount
        if (myCall === 1) await D1
        if (myCall === 2) await D2
        const tablesRead = myCall === 1 ? new Set(['tables-v1']) : new Set(['tables-v2'])
        return { tablesRead }
      },
    })

    const entry = makeEntry('sub1', ['todos'])
    store.add(entry)

    // Fire two invalidations synchronously — arrival order: #1 then #2.
    emit(new Set(['todos']))
    emit(new Set(['todos']))

    // Resolve in REVERSE order: D2 first, then D1.
    // Old allSettled: D2 resolves first → sets tables-v2, then D1 → clobbers to tables-v1.
    // New serialized: #2 hasn't started yet; D2 pre-resolved is fine. #1 finishes (tables-v1),
    // then #2 starts and immediately resolves (tables-v2).
    resolveD2()
    await flush()
    resolveD1()
    await flush()

    // Final tablesWatched MUST reflect the LAST arrived recompute (call #2 → {tables-v2}).
    expect([...entry.tablesWatched].sort()).toEqual(['tables-v2'])
  })

  // ---------------------------------------------------------------------------
  // Concurrency test: DIFFERENT subscriptions affected by the same invalidation
  // MUST run their recomputes concurrently — no cross-sub serialization.
  //
  // Sub-1's gate is held open; sub-2 must complete while sub-1 still blocks.
  // ---------------------------------------------------------------------------
  test('different subs: invalidations run concurrently (no cross-sub serialization)', async () => {
    const store = createInMemorySubscriptionStore()
    const { source, emit } = createDispatchInvalidationSource()

    let resolveSub1!: () => void
    const sub1Gate = new Promise<void>((r) => {
      resolveSub1 = r
    })

    const completed: string[] = []

    createInvalidationRouter({
      source,
      store,
      recompute: async (entry) => {
        if (entry.id === 'sub1') {
          await sub1Gate // sub1 blocks indefinitely until released
        }
        completed.push(entry.id)
        return { tablesRead: new Set(['todos']) }
      },
    })

    store.add(makeEntry('sub1', ['todos']))
    store.add(makeEntry('sub2', ['todos']))

    emit(new Set(['todos']))

    // Give sub2 enough time to finish while sub1 is still blocked.
    await flush()

    expect(completed).toContain('sub2')
    expect(completed).not.toContain('sub1')

    // Unblock sub1 and let it finish.
    resolveSub1()
    await flush()
    expect(completed).toContain('sub1')
  })

  // ---------------------------------------------------------------------------
  // Error isolation: a recompute that throws must NOT break subsequent
  // recomputes in the same sub's queue.
  // ---------------------------------------------------------------------------
  test('recompute error does not poison the sub queue', async () => {
    const store = createInMemorySubscriptionStore()
    const { source, emit } = createDispatchInvalidationSource()

    let callCount = 0
    const sent: unknown[] = []

    const entry = makeEntry('sub1', ['todos'], (payload) => sent.push(payload))
    store.add(entry)

    createInvalidationRouter({
      source,
      store,
      recompute: async () => {
        callCount++
        if (callCount === 1) throw new Error('first recompute failed')
        return { tablesRead: new Set(['recovered-table']) }
      },
    })

    // First invalidation — recompute throws. tablesWatched must be PRESERVED.
    // The invalidate frame must still be delivered.
    emit(new Set(['todos']))
    await flush()

    expect(sent.length).toBe(1) // invalidate frame still delivered despite throw
    expect([...entry.tablesWatched].sort()).toEqual(['todos']) // preserved on error

    // Second invalidation — recompute succeeds.
    emit(new Set(['todos']))
    await flush()

    expect(sent.length).toBe(2) // second invalidate also delivered
    expect([...entry.tablesWatched].sort()).toEqual(['recovered-table'])
  })

  // ---------------------------------------------------------------------------
  // No-leak: after a sub is removed, its queue entry self-drains without
  // leaking memory or crashing.
  // ---------------------------------------------------------------------------
  test('removed sub queue entry drains without leaking', async () => {
    const store = createInMemorySubscriptionStore()
    const { source, emit } = createDispatchInvalidationSource()

    let resolveGate!: () => void
    const gate = new Promise<void>((r) => {
      resolveGate = r
    })

    const entry = makeEntry('sub1', ['todos'])
    store.add(entry)

    let computedCalls = 0
    createInvalidationRouter({
      source,
      store,
      recompute: async () => {
        await gate
        computedCalls++
        return { tablesRead: new Set(['todos']) }
      },
    })

    // Emit while the sub is live — recompute starts but blocks on gate.
    emit(new Set(['todos']))

    // Remove the sub BEFORE the gate resolves.
    store.remove('sub1')

    // Resolve the gate — the in-flight recompute completes.
    resolveGate()
    await flush()

    // Must not crash. The recompute ran (fire-and-forget; started before remove).
    // The tail self-cleans via the `.finally` drain guard.
    expect(computedCalls).toBe(1)
  })

  // ---------------------------------------------------------------------------
  // send error isolation: entry.send throwing must not break recompute or
  // queue integrity for the same sub's subsequent invalidations.
  //
  // Both emits use `todos` and both recomputes return `todos` so the entry
  // stays matched on every `getAffected` call.
  // ---------------------------------------------------------------------------
  test('entry.send error does not break subsequent invalidations for the same sub', async () => {
    const store = createInMemorySubscriptionStore()
    const { source, emit } = createDispatchInvalidationSource()

    let sendCount = 0

    const entry = makeEntry('sub1', ['todos'], () => {
      sendCount++
      if (sendCount === 1) throw new Error('send failed on first invalidate')
    })
    store.add(entry)

    let recomputeCount = 0
    createInvalidationRouter({
      source,
      store,
      recompute: async () => {
        recomputeCount++
        // Always return 'todos' so the entry remains matched on subsequent emits.
        return { tablesRead: new Set(['todos']) }
      },
    })

    emit(new Set(['todos']))
    await flush()

    // After first recompute, entry.tablesWatched is still 'todos' — second emit matches.
    emit(new Set(['todos']))
    await flush()

    // Both recomputes ran and second invalidation delivered (send threw on first only).
    expect(recomputeCount).toBe(2)
    expect(sendCount).toBe(2)
  })
})
