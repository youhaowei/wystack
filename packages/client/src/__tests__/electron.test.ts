/**
 * Tests for @wystack/client/electron — fake ipcRenderer, no real Electron.
 *
 * Coverage:
 *   - Pipe level: __connect deferred to a microtask (first c2s frame), call
 *     sent on c2s, inbound result/invalidate on s2c reaches engine, __close
 *     fires onClose(1000).
 *   - Regression (Major): a __close delivered immediately after createPipe,
 *     before the engine attaches handlers, still reaches onClose.
 *   - Regression (P2): an unserializable inbound frame (BigInt / cyclic) is
 *     dropped silently and dispatch keeps working.
 *   - Engine level: createEngine({ createPipe: createElectronPipe }) →
 *     subscribe → invalidate round-trip (no auth, starts authenticated per
 *     IPC trusted-transport convention).
 *   - close() is idempotent; send() is a no-op after close.
 */

import { describe, test, expect } from 'bun:test'
import { createEngine } from '../engine'
import { createElectronPipe, createIpcManager } from '../transport/electron'
import type { IpcRendererLike } from '../transport/electron'

// ─── Fake ipcRenderer ────────────────────────────────────────────────────────

type Listener = (event: unknown, ...args: unknown[]) => void

interface FakeIpc extends IpcRendererLike {
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): this
  removeListener(channel: string, listener: (...args: unknown[]) => void): this
  emit(channel: string, payload: unknown): void
  /** Register a synchronous hook fired whenever the adapter sends on a channel. */
  onSend(hook: (channel: string, payload: unknown) => void): void
  sent: Array<[string, unknown]>
}

/**
 * Minimal fake `ipcRenderer` for unit tests.
 *
 * - `emit(channel, payload)` — deliver a message as if the main process sent it
 *   on `channel`. Used to simulate inbound `s2c` frames.
 * - `onSend(hook)` — fire synchronously inside `send`, so a test can make the
 *   fake auto-reply on `s2c` the instant the adapter writes to `c2s` (used to
 *   reproduce the immediate-reply race deterministically).
 * - `sent` — array of `[channel, payload]` pairs sent by the adapter.
 */
function makeFakeIpc(): FakeIpc {
  const listeners = new Map<string, Set<Listener>>()
  const sendHooks = new Set<(channel: string, payload: unknown) => void>()
  const sent: Array<[string, unknown]> = []

  const ipc: FakeIpc = {
    sent,

    send(channel: string, ...args: unknown[]): void {
      sent.push([channel, args[0]])
      for (const hook of Array.from(sendHooks)) hook(channel, args[0])
    },

    on(channel: string, listener: Listener): FakeIpc {
      let set = listeners.get(channel)
      if (!set) {
        set = new Set()
        listeners.set(channel, set)
      }
      set.add(listener)
      return ipc
    },

    removeListener(channel: string, listener: (...args: unknown[]) => void): FakeIpc {
      listeners.get(channel)?.delete(listener as Listener)
      return ipc
    },

    /** Simulate main-process sending a message on `channel`. */
    emit(channel: string, payload: unknown): void {
      const set = listeners.get(channel)
      if (!set) return
      for (const listener of Array.from(set)) {
        listener(/*event=*/ {}, payload)
      }
    },

    onSend(hook: (channel: string, payload: unknown) => void): void {
      sendHooks.add(hook)
    },
  }

  return ipc
}

/** Drain microtasks so async engine chains and queueMicrotask callbacks land. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 2000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Find the first frame of a given `type` sent on a c2s channel. */
function findSent(ipc: FakeIpc, type: string): [string, unknown] | undefined {
  return ipc.sent.find(
    ([, payload]) =>
      payload !== null &&
      typeof payload === 'object' &&
      (payload as Record<string, unknown>).type === type,
  )
}

// ─── Pipe-level tests ─────────────────────────────────────────────────────────

describe('createElectronPipe', () => {
  test('defers __connect to a microtask, then it is the first c2s frame', async () => {
    const ipc = makeFakeIpc()
    createElectronPipe({ ipcRenderer: ipc })

    // Not sent synchronously on construction.
    expect(ipc.sent.length).toBe(0)

    await settle()

    expect(ipc.sent.length).toBeGreaterThanOrEqual(1)
    expect(ipc.sent[0]).toEqual(['wystack:c2s', { type: '__connect' }])
  })

  test('send() delivers message on wystack:c2s', () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    pipe.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })

    expect(findSent(ipc, 'subscribe')).toEqual([
      'wystack:c2s',
      { type: 'subscribe', id: 's1', path: 'listTodos', args: {} },
    ])
  })

  test('inbound result frame on s2c reaches onMessage handlers', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const received: unknown[] = []
    pipe.onMessage((msg) => received.push(msg))

    ipc.emit('wystack:s2c', { type: 'result', id: 'call1', data: { ok: true } })
    await settle()

    expect(received).toEqual([{ type: 'result', id: 'call1', data: { ok: true } }])
  })

  test('inbound invalidate frame on s2c reaches onMessage handlers', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const received: unknown[] = []
    pipe.onMessage((msg) => received.push(msg))

    ipc.emit('wystack:s2c', { type: 'invalidate', id: 's1' })
    await settle()

    expect(received).toEqual([{ type: 'invalidate', id: 's1' }])
  })

  test('__close on s2c fires onClose with code 1000', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const closeCodes: number[] = []
    pipe.onClose((info) => closeCodes.push(info.code))

    ipc.emit('wystack:s2c', { type: '__close' })
    await settle()

    expect(closeCodes).toEqual([1000])
  })

  test('__close is NOT forwarded to onMessage handlers', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const received: unknown[] = []
    pipe.onMessage((msg) => received.push(msg))

    ipc.emit('wystack:s2c', { type: '__close' })
    await settle()

    expect(received).toEqual([])
  })

  test('inbound __connect on s2c is filtered, not forwarded to onMessage', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const received: unknown[] = []
    pipe.onMessage((msg) => received.push(msg))

    // __connect is a c2s control frame; if it ever arrives on s2c it must be
    // dropped at the boundary, never parsed or forwarded.
    ipc.emit('wystack:s2c', { type: '__connect' })
    await settle()

    expect(received).toEqual([])
  })

  test('close() sends __close on c2s and is idempotent', () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    pipe.close()
    pipe.close() // second call must be a no-op

    const closeFrames = ipc.sent.filter(([, payload]) => {
      return (
        payload !== null &&
        typeof payload === 'object' &&
        (payload as Record<string, unknown>).type === '__close'
      )
    })
    expect(closeFrames.length).toBe(1)
  })

  test('send() is a silent no-op after close()', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    // Let the deferred __connect flush so it does not muddy the count.
    await settle()
    const countBefore = ipc.sent.length

    pipe.close()
    pipe.send({ type: 'subscribe', id: 's2', path: 'q', args: {} })

    // Only the __close frame should have been added, no subscribe.
    expect(ipc.sent.length).toBe(countBefore + 1)
    expect(findSent(ipc, 'subscribe')).toBeUndefined()
  })

  test('close() before the deferred __connect suppresses __connect', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    // Close synchronously, before the microtask flushes __connect.
    pipe.close()
    await settle()

    expect(findSent(ipc, '__connect')).toBeUndefined()
  })

  test('onMessage unsubscribe removes handler', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const received: unknown[] = []
    const unsub = pipe.onMessage((msg) => received.push(msg))

    ipc.emit('wystack:s2c', { type: 'invalidate', id: 's1' })
    await settle()
    expect(received.length).toBe(1)

    unsub()
    ipc.emit('wystack:s2c', { type: 'invalidate', id: 's1' })
    await settle()
    expect(received.length).toBe(1) // no new delivery
  })

  test('malformed inbound frame is silently dropped', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const received: unknown[] = []
    pipe.onMessage((msg) => received.push(msg))

    // Not a valid ServerMessage type
    ipc.emit('wystack:s2c', { type: 'bogus_unknown_type' })
    ipc.emit('wystack:s2c', null)
    ipc.emit('wystack:s2c', 'raw string')
    await settle()

    expect(received).toEqual([])
  })

  // ── Regression (P2): unserializable inbound frame must not throw ───────────

  test('unserializable inbound frame (BigInt) is dropped, dispatch keeps working', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const received: unknown[] = []
    pipe.onMessage((msg) => received.push(msg))

    // BigInt cannot be JSON.stringify'd → guarded stringify must drop it, not
    // throw. emit() would propagate a throw out of the listener, failing the
    // test if the guard were missing.
    expect(() => {
      ipc.emit('wystack:s2c', { type: 'result', id: 'x', data: 10n })
    }).not.toThrow()

    // A subsequent valid frame still dispatches — the listener wasn't poisoned.
    ipc.emit('wystack:s2c', { type: 'invalidate', id: 's1' })
    await settle()

    expect(received).toEqual([{ type: 'invalidate', id: 's1' }])
  })

  test('unserializable inbound frame (cyclic) is dropped, dispatch keeps working', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const received: unknown[] = []
    pipe.onMessage((msg) => received.push(msg))

    const cyclic: Record<string, unknown> = { type: 'result', id: 'y' }
    cyclic.self = cyclic // JSON.stringify throws on a cyclic structure

    expect(() => {
      ipc.emit('wystack:s2c', cyclic)
    }).not.toThrow()

    ipc.emit('wystack:s2c', { type: 'invalidate', id: 's2' })
    await settle()

    expect(received).toEqual([{ type: 'invalidate', id: 's2' }])
  })
})

// ─── Engine-level integration test ────────────────────────────────────────────

describe('createEngine with ElectronPipe', () => {
  test('subscribe → invalidate round-trip (no auth, trusted IPC)', async () => {
    const ipc = makeFakeIpc()

    // Engine with no getToken → requiresAuth defaults false → starts authenticated
    const engine = createEngine({
      createPipe: () => createElectronPipe({ ipcRenderer: ipc }),
    })
    engine.connect()
    await settle()

    const invalidated = deferred<void>()
    engine.subscribe('s1', 'listTodos', {}, () => invalidated.resolve())
    await settle()

    // Engine should have sent subscribe on c2s (after __connect)
    const subscribeFrame = findSent(ipc, 'subscribe')
    expect(subscribeFrame).toBeDefined()
    expect(subscribeFrame![1]).toEqual({
      type: 'subscribe',
      id: 's1',
      path: 'listTodos',
      args: {},
    })

    // Server sends subscribed ack then invalidate
    ipc.emit('wystack:s2c', { type: 'subscribed', id: 's1' })
    ipc.emit('wystack:s2c', { type: 'invalidate', id: 's1' })

    await withTimeout(invalidated.promise, 'invalidate delivery')
    engine.disconnect()
  })

  test('__close on s2c triggers engine close handler', async () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const closeFired = deferred<number>()
    pipe.onClose((info) => closeFired.resolve(info.code))

    ipc.emit('wystack:s2c', { type: '__close' })
    await settle()

    const code = await withTimeout(closeFired.promise, '__close fires onClose')
    expect(code).toBe(1000)
  })

  // ── Regression (Major): __connect startup race ─────────────────────────────

  test('immediate __close reply (before handlers attach) still reaches onClose', async () => {
    // Reproduces the dropped-close race: the engine attaches onMessage/onClose
    // *after* createPipe() returns. If __connect were sent synchronously inside
    // the constructor, the server's immediate __close reply would arrive while
    // closeHandlers is still empty and be lost. The microtask deferral fixes
    // this — the fake auto-replies __close the instant it sees __connect on
    // c2s, and the handler (attached after construction, like the engine does)
    // must still observe it.
    const ipc = makeFakeIpc()

    ipc.onSend((channel, payload) => {
      if (
        channel === 'wystack:c2s' &&
        payload !== null &&
        typeof payload === 'object' &&
        (payload as Record<string, unknown>).type === '__connect'
      ) {
        // Synchronously bounce a clean close back on s2c.
        ipc.emit('wystack:s2c', { type: '__close' })
      }
    })

    const pipe = createElectronPipe({ ipcRenderer: ipc })

    // Attach onClose AFTER construction — exactly the engine's ordering.
    const closeFired = deferred<number>()
    pipe.onClose((info) => closeFired.resolve(info.code))

    await settle()

    const code = await withTimeout(closeFired.promise, 'immediate __close reaches onClose')
    expect(code).toBe(1000)
  })
})

// ─── IpcManager convenience shim ─────────────────────────────────────────────

describe('createIpcManager', () => {
  test('connect / isConnected / disconnect', async () => {
    const ipc = makeFakeIpc()
    const manager = createIpcManager({ ipcRenderer: ipc })

    manager.connect()
    await settle()

    expect(manager.isConnected()).toBe(true)

    manager.disconnect()
    expect(manager.isConnected()).toBe(false)
  })

  test('subscribe triggers invalidate delivery', async () => {
    const ipc = makeFakeIpc()
    const manager = createIpcManager({ ipcRenderer: ipc })

    manager.connect()
    await settle()

    const invalidated = deferred<void>()
    manager.subscribe('m1', 'listTodos', {}, () => invalidated.resolve())
    await settle()

    ipc.emit('wystack:s2c', { type: 'subscribed', id: 'm1' })
    ipc.emit('wystack:s2c', { type: 'invalidate', id: 'm1' })

    await withTimeout(invalidated.promise, 'manager invalidate')
    manager.disconnect()
  })

  test('unsubscribe sends unsubscribe frame on c2s', async () => {
    const ipc = makeFakeIpc()
    const manager = createIpcManager({ ipcRenderer: ipc })

    manager.connect()
    await settle()

    manager.subscribe('m2', 'q', {}, () => {})
    await settle()

    manager.unsubscribe('m2')
    await settle()

    const unsubFrame = findSent(ipc, 'unsubscribe')
    expect(unsubFrame).toBeDefined()
    expect(unsubFrame![1]).toEqual({ type: 'unsubscribe', id: 'm2' })

    manager.disconnect()
  })
})
