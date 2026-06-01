// Engine tests driven by the in-memory loopback Pipe — proves the engine is
// transport-neutral. No WebSocket, no HTTP, no @tanstack/*.

import { describe, test, expect } from 'bun:test'
import {
  createLoopbackPair,
  type ClientMessage,
  type ServerMessage,
  type Pipe,
} from '@wystack/transport'
import { createEngine, CallNotReadyError, type EnginePipe, type CloseInfo } from '../engine'

/**
 * Wrap a base `Pipe` into the engine's `EnginePipe` shape, exposing a manual
 * `triggerClose` so tests can synthesize 4001/4002 close codes that the
 * loopback adapter itself does not produce.
 */
function withCloseSignal<In, Out>(
  base: Pipe<In, Out>,
): {
  pipe: Pipe<In, Out> & { onClose(handler: (info: CloseInfo) => void): () => void }
  triggerClose: (code: number) => void
} {
  const handlers = new Set<(info: CloseInfo) => void>()
  return {
    pipe: {
      get id() {
        return base.id
      },
      send: base.send.bind(base),
      onMessage: base.onMessage.bind(base),
      close: base.close.bind(base),
      onClose(handler) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    },
    triggerClose(code: number) {
      for (const handler of Array.from(handlers)) handler({ code })
    },
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

/** Drain enough microtasks for the engine's async open chain to land. */
async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 1000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
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

/**
 * Spin up a fake "server" on the far end of a loopback pair. The harness
 * records every client-side frame as soon as the pipe is constructed — so
 * tests don't have to race the engine's first send.
 */
type ServerCallbacks = {
  /** Frames the engine has sent, in arrival order. Settled lazily — drain
   * with `await settle()` before assertions. */
  received: ClientMessage[]
  send(msg: ServerMessage): void
  close(): void
}

function makeServerSide(): {
  createPipe: () => EnginePipe
  /** The latest server-side handle. Throws if no pipe has been opened yet. */
  server: () => ServerCallbacks
  closeActive: (code: number) => void
  pairCount: () => number
} {
  let activeServer: ServerCallbacks | null = null
  let activeTrigger: ((code: number) => void) | null = null
  let count = 0
  return {
    createPipe() {
      const [clientPipe, serverPipe] = createLoopbackPair<ServerMessage, ClientMessage>()
      const wrapped = withCloseSignal(clientPipe)
      count++
      activeTrigger = wrapped.triggerClose
      const received: ClientMessage[] = []
      // Subscribe synchronously, before the engine has a chance to send —
      // loopback snapshot-on-send means a later subscribe would miss the
      // initial frames.
      serverPipe.onMessage((msg) => received.push(msg))
      activeServer = {
        received,
        send: (msg) => serverPipe.send(msg),
        close: () => serverPipe.close(),
      }
      return wrapped.pipe
    },
    server() {
      if (activeServer === null) throw new Error('no active server pipe')
      return activeServer
    },
    closeActive(code: number) {
      activeTrigger?.(code)
    },
    pairCount: () => count,
  }
}

describe('createEngine', () => {
  test('no-auth: subscribe immediately delivers invalidate', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()

    // Drain microtasks so the engine's async pipe-open chain lands and the
    // server-side pipe is attached.
    await settle()

    const invalidated = deferred<void>()
    engine.subscribe('s1', 'listTodos', {}, () => invalidated.resolve())

    const server = harness.server()
    await settle()
    expect(server.received).toEqual([{ type: 'subscribe', id: 's1', path: 'listTodos', args: {} }])

    server.send({ type: 'subscribed', id: 's1' })
    server.send({ type: 'invalidate', id: 's1' })

    await withTimeout(invalidated.promise, 'invalidate')
    engine.disconnect()
  })

  test('auth handshake: buffers subscribes until authenticated ack', async () => {
    const harness = makeServerSide()
    const engine = createEngine({
      createPipe: harness.createPipe,
      getToken: () => 'tkn',
    })
    engine.connect()

    const invalidated = deferred<void>()
    // Subscribe BEFORE the server acks auth — must be buffered.
    engine.subscribe('s1', 'listTodos', {}, () => invalidated.resolve())

    await settle()
    const server = harness.server()
    // First (and only) frame so far must be the auth handshake.
    expect(server.received).toEqual([{ type: 'auth', token: 'tkn' }])

    // Server acks — engine should now flush the buffered subscribe.
    server.send({ type: 'authenticated' })
    await settle()
    expect(server.received).toEqual([
      { type: 'auth', token: 'tkn' },
      { type: 'subscribe', id: 's1', path: 'listTodos', args: {} },
    ])

    server.send({ type: 'invalidate', id: 's1' })
    await withTimeout(invalidated.promise, 'invalidate')
    engine.disconnect()
  })

  test('auth handshake: null token for cookie/proxy auth', async () => {
    const harness = makeServerSide()
    const engine = createEngine({
      createPipe: harness.createPipe,
      requiresAuth: true, // no getToken
    })
    engine.connect()

    await settle()
    // Spec contract: `token: null` (explicit, not absent) for anonymous auth.
    expect(harness.server().received).toEqual([{ type: 'auth', token: null }])
    engine.disconnect()
  })

  test('close 4001 latches authFailed, fires invalidations, no reconnect', async () => {
    const harness = makeServerSide()
    const engine = createEngine({
      createPipe: harness.createPipe,
      getToken: () => null,
    })
    engine.connect()

    let invalidations = 0
    engine.subscribe('s1', 'listTodos', {}, () => {
      invalidations++
    })

    await settle()
    expect(harness.pairCount()).toBe(1)

    // Synthesize the 4001 close that the server would send on auth rejection.
    harness.closeActive(4001)

    // 4001 must fire invalidations so HTTP refetches surface the auth error.
    await settle()
    expect(invalidations).toBe(1)
    expect(engine.isConnected()).toBe(false)

    // Wait longer than the minimum reconnect backoff window (~500ms-1s) to
    // prove no retry pipe was opened.
    await new Promise((r) => setTimeout(r, 1200))
    expect(harness.pairCount()).toBe(1)
    engine.disconnect()
  })

  test('re-subscribes on reconnect (transient close)', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()

    await settle()
    const firstServer = harness.server()
    engine.subscribe('s1', 'listTodos', {}, () => {})
    await settle()
    expect(firstServer.received).toEqual([
      { type: 'subscribe', id: 's1', path: 'listTodos', args: {} },
    ])

    // Close transiently (any non-4001) — engine schedules backoff reconnect.
    harness.closeActive(1006)

    // Backoff base is 1000ms with [50%, 100%) jitter — wait long enough for
    // the first attempt to fire.
    await new Promise((r) => setTimeout(r, 1800))
    expect(harness.pairCount()).toBeGreaterThanOrEqual(2)

    // Engine must replay the active subscription after the new pipe opens.
    const secondServer = harness.server()
    await settle()
    expect(secondServer.received).toEqual([
      { type: 'subscribe', id: 's1', path: 'listTodos', args: {} },
    ])
    engine.disconnect()
  }, 10_000)

  test('unsubscribe stops invalidation delivery and notifies server', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()

    await settle()
    const server = harness.server()

    let invalidations = 0
    engine.subscribe('s1', 'listTodos', {}, () => {
      invalidations++
    })

    await settle()
    server.send({ type: 'invalidate', id: 's1' })
    await settle()
    expect(invalidations).toBe(1)

    engine.unsubscribe('s1')
    await settle()
    expect(server.received[server.received.length - 1]).toEqual({
      type: 'unsubscribe',
      id: 's1',
    })

    // Late invalidate for a torn-down sub must not fire.
    server.send({ type: 'invalidate', id: 's1' })
    await settle()
    expect(invalidations).toBe(1)
    engine.disconnect()
  })

  test('onSubscribed fires per server ack', async () => {
    const harness = makeServerSide()
    const acks: string[] = []
    const engine = createEngine({
      createPipe: harness.createPipe,
      onSubscribed: (id) => acks.push(id),
    })
    engine.connect()

    engine.subscribe('a', 'q', {}, () => {})
    engine.subscribe('b', 'q', {}, () => {})

    await settle()
    const server = harness.server()
    server.send({ type: 'subscribed', id: 'a' })
    server.send({ type: 'subscribed', id: 'b' })

    await settle()
    expect(acks).toEqual(['a', 'b'])
    engine.disconnect()
  })

  test('auth ack timeout synthesizes 4002 and reconnects', async () => {
    // Server never sends `{type:"authenticated"}` — engine's local
    // authAckTimer must fire, close the pipe, and schedule a reconnect.
    // This path isn't reachable from the integration ws.test.ts because the
    // real server sends its own 4002 first; the loopback exposes it.
    const harness = makeServerSide()
    const engine = createEngine({
      createPipe: harness.createPipe,
      getToken: () => 'tkn',
      authAckTimeoutMs: 30,
    })
    engine.connect()

    await settle()
    expect(harness.pairCount()).toBe(1)

    // Wait past authAckTimeoutMs + reconnect backoff window so the engine
    // synthesizes the 4002 and opens a fresh pipe.
    await new Promise((r) => setTimeout(r, 1800))
    expect(harness.pairCount()).toBeGreaterThanOrEqual(2)
    engine.disconnect()
  }, 10_000)

  test('disconnect during async createPipe drops the stale pipe', async () => {
    let resolveCreate: ((pipe: EnginePipe) => void) | null = null
    let createdAndClosed = false
    const engine = createEngine({
      createPipe: () =>
        new Promise<EnginePipe>((res) => {
          resolveCreate = (pipe) => {
            // Wrap close so the test can detect that the engine disposed the
            // stale pipe instead of using it.
            const original = pipe.close.bind(pipe)
            pipe.close = () => {
              createdAndClosed = true
              return original()
            }
            res(pipe)
          }
        }),
    })
    engine.connect()
    // Settle so the engine's `Promise.resolve().then(createPipe)` runs and
    // populates resolveCreate.
    await settle()
    expect(resolveCreate).not.toBeNull()

    // Disconnect before the pipe finishes opening.
    engine.disconnect()

    const harness = makeServerSide()
    resolveCreate!(harness.createPipe())

    await settle()
    expect(createdAndClosed).toBe(true)
    expect(engine.isConnected()).toBe(false)
  })

  test('connect is single-flight while pipe is opening', async () => {
    const ready = deferred<EnginePipe>()
    let createCalls = 0
    const engine = createEngine({
      createPipe: () => {
        createCalls++
        return ready.promise
      },
    })

    engine.connect()
    engine.connect()
    await settle()

    expect(createCalls).toBe(1)

    const harness = makeServerSide()
    ready.resolve(harness.createPipe())
    await settle()

    expect(engine.isConnected()).toBe(true)
    engine.disconnect()
  })

  test('rejected async send closes active pipe', async () => {
    const closeHandlers = new Set<(info: CloseInfo) => void>()
    const pipe: EnginePipe = {
      id: 'rejecting',
      send: () => Promise.reject(new Error('send failed')),
      onMessage: () => () => {},
      close: () => {},
      onClose(handler) {
        closeHandlers.add(handler)
        return () => {
          closeHandlers.delete(handler)
        }
      },
    }
    const engine = createEngine({ createPipe: () => pipe })

    engine.connect()
    await settle()
    expect(engine.isConnected()).toBe(true)

    engine.subscribe('s1', 'listTodos', {}, () => {})
    await settle()

    expect(engine.isConnected()).toBe(false)
    expect(closeHandlers.size).toBe(0)
    engine.disconnect()
  })

  test('pending pipe readiness does not report connected', async () => {
    const harness = makeServerSide()
    const ready = deferred<void>()
    const engine = createEngine({
      createPipe: () => ({ ...harness.createPipe(), ready: ready.promise }),
    })

    engine.connect()
    await settle()

    expect(harness.pairCount()).toBe(1)
    expect(engine.isConnected()).toBe(false)

    ready.resolve()
    await settle()

    expect(engine.isConnected()).toBe(true)
    engine.disconnect()
  })

  test('auth ack timeout starts after pipe readiness', async () => {
    const harness = makeServerSide()
    const ready = deferred<void>()
    const engine = createEngine({
      createPipe: () => ({ ...harness.createPipe(), ready: ready.promise }),
      getToken: () => 'tkn',
      authAckTimeoutMs: 30,
    })

    engine.connect()
    await settle()

    await new Promise((r) => setTimeout(r, 80))
    expect(harness.pairCount()).toBe(1)
    expect(harness.server().received).toEqual([])

    ready.resolve()
    await settle()
    expect(harness.server().received).toEqual([{ type: 'auth', token: 'tkn' }])

    await new Promise((r) => setTimeout(r, 1800))
    expect(harness.pairCount()).toBeGreaterThanOrEqual(2)
    engine.disconnect()
  }, 10_000)

  test('requiresAuth:false with getToken set sends no auth frame', async () => {
    // Spec contract: requiresAuth:false suppresses the auth handshake even
    // when getToken is provided (trusted transports — server has no
    // resolveContext). The first frame must be a subscribe, not an auth.
    const harness = makeServerSide()
    const engine = createEngine({
      createPipe: harness.createPipe,
      getToken: () => 'tkn',
      requiresAuth: false,
    })
    engine.connect()
    engine.subscribe('s1', 'q', {}, () => {})

    await settle()
    const server = harness.server()
    expect(server.received[0]).toEqual({ type: 'subscribe', id: 's1', path: 'q', args: {} })
    expect(server.received.some((f) => f.type === 'auth')).toBe(false)
    engine.disconnect()
  })

  test('authFailed latch blocks manual connect() after 4001', async () => {
    // Spec: close 4001 → do NOT reconnect. Manual connect() calls while the
    // latch is set must also be no-ops, not just the auto-reconnect timer.
    const harness = makeServerSide()
    const engine = createEngine({
      createPipe: harness.createPipe,
      getToken: () => null,
    })
    engine.connect()
    await settle()
    expect(harness.pairCount()).toBe(1)

    harness.closeActive(4001)
    await settle()

    // Manual reconnect attempt — must be blocked by the authFailed latch.
    engine.connect()
    await settle()
    expect(harness.pairCount()).toBe(1)
    engine.disconnect()
  })

  test('disconnect() resets authFailed, enabling re-login reconnect', async () => {
    // engine.ts documents: "Reset so a later connect() (e.g., after re-login)
    // can try again." Verify the full sequence: 4001 → disconnect() → connect()
    // opens a new pipe.
    const harness = makeServerSide()
    const engine = createEngine({
      createPipe: harness.createPipe,
      getToken: () => null,
    })
    engine.connect()
    await settle()
    expect(harness.pairCount()).toBe(1)

    harness.closeActive(4001)
    await settle()

    // disconnect() clears authFailed; connect() should now open a new pipe.
    engine.disconnect()
    engine.connect()
    await settle()
    expect(harness.pairCount()).toBe(2)
    engine.disconnect()
  })
})

// ─── Call / result correlation (YW-97 / T3d) ─────────────────────────────────

describe('engine.call — call/result correlation', () => {
  test('call→result: loopback round-trip resolves with data', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const result = engine.call('users.list', {})
    await settle()

    // Server sees the call frame.
    const server = harness.server()
    const callFrame = server.received.find((f) => f.type === 'call') as
      | Extract<ClientMessage, { type: 'call' }>
      | undefined
    expect(callFrame).toBeDefined()
    expect(callFrame!.path).toBe('users.list')
    expect(callFrame!.args).toEqual({})

    // Server replies with the matching result.
    server.send({ type: 'result', id: callFrame!.id, data: [{ id: 1 }] })
    await settle()

    await withTimeout(result, 'call round-trip')
    expect(await result).toEqual([{ id: 1 }])
    engine.disconnect()
  })

  test('concurrent calls correlate by id — no cross-talk', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const resultA = engine.call('path.a', {})
    const resultB = engine.call('path.b', {})
    await settle()

    const server = harness.server()
    const callFrames = server.received.filter((f) => f.type === 'call') as Extract<
      ClientMessage,
      { type: 'call' }
    >[]
    expect(callFrames).toHaveLength(2)

    const frameA = callFrames.find((f) => f.path === 'path.a')!
    const frameB = callFrames.find((f) => f.path === 'path.b')!
    expect(frameA).toBeDefined()
    expect(frameB).toBeDefined()
    expect(frameA.id).not.toBe(frameB.id)

    // Reply in REVERSE ORDER to prove there's no positional assumption.
    server.send({ type: 'result', id: frameB.id, data: 'b-data' })
    server.send({ type: 'result', id: frameA.id, data: 'a-data' })
    await settle()

    expect(await withTimeout(resultA, 'resultA')).toBe('a-data')
    expect(await withTimeout(resultB, 'resultB')).toBe('b-data')
    engine.disconnect()
  })

  test('error frame with matching id rejects the call', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const result = engine.call('path.fail', {})
    await settle()

    const server = harness.server()
    const callFrame = server.received.find((f) => f.type === 'call') as
      | Extract<ClientMessage, { type: 'call' }>
      | undefined
    expect(callFrame).toBeDefined()

    server.send({ type: 'error', id: callFrame!.id, error: 'not found' })
    await settle()

    await expect(result).rejects.toThrow('not found')
    engine.disconnect()
  })

  test('error frame with issues attaches them to the rejection', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const result = engine.call('path.validate', {})
    await settle()

    const server = harness.server()
    const callFrame = server.received.find((f) => f.type === 'call') as
      | Extract<ClientMessage, { type: 'call' }>
      | undefined
    expect(callFrame).toBeDefined()

    const issues = [{ message: 'Required', path: ['name'] }]
    server.send({ type: 'error', id: callFrame!.id, error: 'validation failed', issues })
    await settle()

    let caught: unknown
    await result.catch((e) => {
      caught = e
    })
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toBe('validation failed')
    expect((caught as Error & { issues?: unknown[] }).issues).toEqual(issues)
    engine.disconnect()
  })

  test('pipe close rejects all pending calls (no hangs)', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const result = engine.call('slow.path', {})
    await settle()

    // Close the pipe before the server replies — engine must reject pending.
    harness.closeActive(1006)
    await settle()

    await expect(result).rejects.toThrow('pipe closed')
    engine.disconnect()
  })

  test('disconnect rejects all pending calls immediately', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const result = engine.call('slow.path', {})
    await settle()

    engine.disconnect()
    await settle()

    await expect(result).rejects.toThrow('disconnected')
  })

  test('reconnect after close does not resolve stale calls', async () => {
    // Scenario: call in gen-1 → close → reconnect (gen-2) → server sends
    // result with gen-1 id → must NOT resolve (call was already rejected).
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const result = engine.call('slow.path', {})
    await settle()

    const server = harness.server()
    const callFrame = server.received.find((f) => f.type === 'call') as
      | Extract<ClientMessage, { type: 'call' }>
      | undefined
    expect(callFrame).toBeDefined()

    // Close — call is rejected with 'pipe closed'.
    harness.closeActive(1006)
    await settle()

    await expect(result).rejects.toThrow('pipe closed')

    // Wait for reconnect to open a new pipe.
    await new Promise((r) => setTimeout(r, 1800))
    expect(harness.pairCount()).toBeGreaterThanOrEqual(2)
    await settle()

    // Now the (stale) server delivers a result for the old id on the new pipe.
    // Engine's pending map was cleared on close — this must be a silent no-op.
    harness.server().send({ type: 'result', id: callFrame!.id, data: 'stale' })
    await settle()

    // The previously-rejected promise is already settled; it stays rejected.
    // (No assertion needed beyond the rejects.toThrow above, but we verify
    // isConnected to confirm gen-2 is live and not corrupted by the stale frame.)
    expect(engine.isConnected()).toBe(true)
    engine.disconnect()
  }, 10_000)

  test('call() rejects immediately when not connected', async () => {
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    // connect() not called yet

    await expect(engine.call('path', {})).rejects.toBeInstanceOf(CallNotReadyError)
  })

  test('call() rejects immediately when auth handshake is pending', async () => {
    const harness = makeServerSide()
    const engine = createEngine({
      createPipe: harness.createPipe,
      getToken: () => 'tkn',
    })
    engine.connect()
    await settle()
    // Connected but not yet authenticated (server hasn't sent `authenticated`).
    expect(engine.isConnected()).toBe(true)

    await expect(engine.call('path', {})).rejects.toBeInstanceOf(CallNotReadyError)
    engine.disconnect()
  })

  test('connection-level error frame (no id) does not reject any pending call', async () => {
    // An `error` frame without an `id` is a connection-level signal. It should
    // leave pending calls intact (they're still waiting for a result or a close).
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const result = engine.call('path', {})
    await settle()

    const server = harness.server()
    // Send a connection-level error (no id).
    server.send({ type: 'error', error: 'server error' })
    await settle()

    // Call must still be pending — not resolved, not rejected yet.
    let settled = false
    void result.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await settle()
    expect(settled).toBe(false)

    // Now resolve it properly.
    const callFrame = server.received.find((f) => f.type === 'call') as
      | Extract<ClientMessage, { type: 'call' }>
      | undefined
    expect(callFrame).toBeDefined()
    server.send({ type: 'result', id: callFrame!.id, data: 'ok' })
    await settle()

    expect(await withTimeout(result, 'result after connection-level error')).toBe('ok')
    engine.disconnect()
  })
})
