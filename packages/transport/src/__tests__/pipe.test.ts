import { describe, test, expect } from 'bun:test'
import { createLoopbackPair, type Pipe } from '../index'

// ─── Type-level sanity ───────────────────────────────────────────────────────
// The brief locks the tuple ordering: `createLoopbackPair<A, B>` returns
// `[Pipe<A, B>, Pipe<B, A>]`. If that contract drifts, this assignment stops
// compiling.
const _typeChecks = (): void => {
  const [a, b] = createLoopbackPair<string, number>()
  const pa: Pipe<string, number> = a
  const pb: Pipe<number, string> = b
  void pa
  void pb

  // Default is `unknown` on both sides — no explicit type args.
  const [u1, u2] = createLoopbackPair()
  const pu1: Pipe<unknown, unknown> = u1
  const pu2: Pipe<unknown, unknown> = u2
  void pu1
  void pu2
}
void _typeChecks

// ─── Delivery ────────────────────────────────────────────────────────────────

describe('createLoopbackPair — delivery', () => {
  test('A.send delivers to B.onMessage', async () => {
    const [a, b] = createLoopbackPair<string, string>()
    const received: string[] = []
    b.onMessage((m) => received.push(m))
    a.send('hello')
    await flushMicrotasks()
    expect(received).toEqual(['hello'])
  })

  test('B.send delivers to A.onMessage (bidirectional)', async () => {
    const [a, b] = createLoopbackPair<string, string>()
    const received: string[] = []
    a.onMessage((m) => received.push(m))
    b.send('back')
    await flushMicrotasks()
    expect(received).toEqual(['back'])
  })

  test('preserves payload identity (object passes by reference)', async () => {
    const [a, b] = createLoopbackPair<{ x: number }, { x: number }>()
    const payload = { x: 1 }
    const received: { x: number }[] = []
    b.onMessage((m) => {
      received.push(m)
    })
    a.send(payload)
    await flushMicrotasks()
    expect(received).toHaveLength(1)
    expect(received[0]).toBe(payload)
  })

  test('delivery is asynchronous — handler does not fire inside send', () => {
    const [a, b] = createLoopbackPair<string, string>()
    let fired = false
    b.onMessage(() => {
      fired = true
    })
    a.send('hello')
    // Same synchronous tick: handler must not have run.
    expect(fired).toBe(false)
  })

  test('multiple handlers on one end all receive each message', async () => {
    const [a, b] = createLoopbackPair<string, string>()
    const r1: string[] = []
    const r2: string[] = []
    b.onMessage((m) => r1.push(m))
    b.onMessage((m) => r2.push(m))
    a.send('hi')
    await flushMicrotasks()
    expect(r1).toEqual(['hi'])
    expect(r2).toEqual(['hi'])
  })
})

// ─── Identity ────────────────────────────────────────────────────────────────

describe('createLoopbackPair — identity', () => {
  test('each end has a stable, distinct id', () => {
    const [a, b] = createLoopbackPair()
    expect(typeof a.id).toBe('string')
    expect(typeof b.id).toBe('string')
    expect(a.id).not.toBe(b.id)
    // Stable on subsequent reads.
    expect(a.id).toBe(a.id)
  })

  test('ids are unique across pairs', () => {
    const [a1] = createLoopbackPair()
    const [a2] = createLoopbackPair()
    expect(a1.id).not.toBe(a2.id)
  })
})

// ─── Unsubscribe ─────────────────────────────────────────────────────────────

describe('createLoopbackPair — unsubscribe', () => {
  test('unsubscribed handler stops receiving', async () => {
    const [a, b] = createLoopbackPair<string, string>()
    const received: string[] = []
    const unsub = b.onMessage((m) => received.push(m))
    a.send('first')
    await flushMicrotasks()
    unsub()
    a.send('second')
    await flushMicrotasks()
    expect(received).toEqual(['first'])
  })

  test('unsubscribe is idempotent', async () => {
    const [a, b] = createLoopbackPair<string, string>()
    const received: string[] = []
    const unsub = b.onMessage((m) => received.push(m))
    unsub()
    unsub()
    a.send('x')
    await flushMicrotasks()
    expect(received).toEqual([])
  })

  test('handler unsubscribed mid-batch still does not fire', async () => {
    // queueMicrotask snapshot vs live re-check: a handler that unsubscribes
    // after `send` schedules the delivery but before the microtask runs
    // must not be invoked.
    const [a, b] = createLoopbackPair<string, string>()
    const received: string[] = []
    const unsub = b.onMessage((m) => received.push(m))
    a.send('queued')
    unsub()
    await flushMicrotasks()
    expect(received).toEqual([])
  })
})

// ─── Close ───────────────────────────────────────────────────────────────────

describe('createLoopbackPair — close', () => {
  test('close on A: B.send becomes a no-op (no throw, no delivery)', async () => {
    const [a, b] = createLoopbackPair<string, string>()
    const received: string[] = []
    a.onMessage((m) => received.push(m))
    a.close()
    expect(() => b.send('after-close')).not.toThrow()
    await flushMicrotasks()
    expect(received).toEqual([])
  })

  test('close is bidirectional — closing A also closes B', async () => {
    const [a, b] = createLoopbackPair<string, string>()
    const onA: string[] = []
    a.onMessage((m) => onA.push(m))
    a.close()
    // B sees its own send as a silent no-op too.
    expect(() => b.send('drop')).not.toThrow()
    // And a fresh handler registration on B is also a no-op.
    expect(() => b.onMessage(() => {})).not.toThrow()
    await flushMicrotasks()
    expect(onA).toEqual([])
  })

  test('close is idempotent — second close does not throw', () => {
    const [a] = createLoopbackPair()
    a.close()
    expect(() => a.close()).not.toThrow()
  })

  test('send after close is a no-op on the closed end', async () => {
    const [a, b] = createLoopbackPair<string, string>()
    const onB: string[] = []
    b.onMessage((m) => onB.push(m))
    a.close()
    expect(() => a.send('nope')).not.toThrow()
    await flushMicrotasks()
    expect(onB).toEqual([])
  })

  test('onMessage after close returns a no-op unsubscribe', () => {
    const [a] = createLoopbackPair()
    a.close()
    const unsub = a.onMessage(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  test('in-flight microtask delivery dropped if partner closes between send and run', async () => {
    const [a, b] = createLoopbackPair<string, string>()
    const received: string[] = []
    a.onMessage((m) => received.push(m))
    b.send('in-flight')
    // Close before the microtask runs.
    a.close()
    await flushMicrotasks()
    expect(received).toEqual([])
  })
})

// Helper — yield once so all queued microtasks drain. Bun's `bun:test` does
// not auto-flush microtasks between assertions, so tests that depend on
// `queueMicrotask` ordering await this between `send` and the assertion.
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
