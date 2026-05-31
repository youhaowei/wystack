/**
 * Tests for @wystack/client/electron — fake ipcRenderer, no real Electron.
 *
 * Coverage:
 *   - Pipe level: __connect sent on construction, call sent on c2s, inbound
 *     result/invalidate on s2c reaches engine, __close fires onClose(1000).
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
  sent: Array<[string, unknown]>
}

/**
 * Minimal fake `ipcRenderer` for unit tests.
 *
 * - `emit(channel, payload)` — deliver a message as if the main process sent it
 *   on `channel`. Used to simulate inbound `s2c` frames.
 * - `sent` — array of `[channel, payload]` pairs sent by the adapter.
 */
function makeFakeIpc(): FakeIpc {
  const listeners = new Map<string, Set<Listener>>()
  const sent: Array<[string, unknown]> = []

  const ipc: FakeIpc = {
    sent,

    send(channel: string, ...args: unknown[]): void {
      sent.push([channel, args[0]])
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

// ─── Pipe-level tests ─────────────────────────────────────────────────────────

describe('createElectronPipe', () => {
  test('sends __connect on construction', () => {
    const ipc = makeFakeIpc()
    createElectronPipe({ ipcRenderer: ipc })

    expect(ipc.sent.length).toBeGreaterThanOrEqual(1)
    expect(ipc.sent[0]).toEqual(['wystack:c2s', { type: '__connect' }])
  })

  test('send() delivers message on wystack:c2s', () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    pipe.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })

    // sent[0] is __connect; sent[1] is the subscribe frame
    expect(ipc.sent[1]).toEqual([
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

  test('send() is a silent no-op after close()', () => {
    const ipc = makeFakeIpc()
    const pipe = createElectronPipe({ ipcRenderer: ipc })

    const countBefore = ipc.sent.length
    pipe.close()
    pipe.send({ type: 'subscribe', id: 's2', path: 'q', args: {} })

    expect(ipc.sent.length).toBe(countBefore + 1) // only the __close frame, no subscribe
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
    const subscribeFrame = ipc.sent.find(
      ([, payload]) =>
        payload !== null &&
        typeof payload === 'object' &&
        (payload as Record<string, unknown>).type === 'subscribe',
    )
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

    const unsubFrame = ipc.sent.find(
      ([, payload]) =>
        payload !== null &&
        typeof payload === 'object' &&
        (payload as Record<string, unknown>).type === 'unsubscribe',
    )
    expect(unsubFrame).toBeDefined()
    expect(unsubFrame![1]).toEqual({ type: 'unsubscribe', id: 'm2' })

    manager.disconnect()
  })
})
