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

  test('durable subscription error stops the retry loop — drops the sub, fires onError, no replay (YW-108)', async () => {
    // Regression (YW-108): a `kind: 'subscription'` error must drop the sub so
    // reconnect's sendSubscriptions() does NOT replay it. Without the drop, the
    // sub stays in activeSubs and every reconnect re-sends it → another sub
    // error → silent infinite loop. The terminating proxy: after the error, a
    // reconnect produces NO subscribe frame for that id.
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const firstServer = harness.server()
    const errors: Error[] = []
    engine.subscribe(
      's1',
      'unknown.query',
      {},
      () => {},
      (err) => errors.push(err),
    )
    await settle()
    expect(firstServer.received).toEqual([
      { type: 'subscribe', id: 's1', path: 'unknown.query', args: {} },
    ])

    // Server rejects the subscription with a durable error.
    firstServer.send({
      type: 'error',
      kind: 'subscription',
      id: 's1',
      error: 'Unknown query: unknown.query',
    })
    await settle()

    // onError fired with the durable error.
    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toBe('Unknown query: unknown.query')

    // Now force a reconnect. The dropped sub must NOT be replayed.
    harness.closeActive(1006)
    await new Promise((r) => setTimeout(r, 1800))
    expect(harness.pairCount()).toBeGreaterThanOrEqual(2)

    const secondServer = harness.server()
    await settle()
    // The loop-stopper: no subscribe frame for the dropped sub on the new pipe.
    expect(secondServer.received.filter((f) => f.type === 'subscribe')).toEqual([])

    engine.disconnect()
  }, 10_000)

  test('subscription error without onError still drops the sub (no loop, no throw)', async () => {
    // onError is optional. A subscription error must still drop the sub even when
    // no callback was registered — the loop fix is independent of the callback.
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const firstServer = harness.server()
    engine.subscribe('s1', 'unknown.query', {}, () => {})
    await settle()

    firstServer.send({ type: 'error', kind: 'subscription', id: 's1', error: 'boom' })
    await settle()

    harness.closeActive(1006)
    await new Promise((r) => setTimeout(r, 1800))
    expect(harness.pairCount()).toBeGreaterThanOrEqual(2)

    const secondServer = harness.server()
    await settle()
    expect(secondServer.received.filter((f) => f.type === 'subscribe')).toEqual([])

    engine.disconnect()
  }, 10_000)

  test('after a subscription error, a late invalidate for the dropped id is a no-op (YW-108)', async () => {
    // The sub was removed from `handlers`, so a stale `invalidate` for it must
    // not fire the (now-gone) onInvalidate.
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const server = harness.server()
    let invalidations = 0
    engine.subscribe(
      's1',
      'unknown.query',
      {},
      () => {
        invalidations++
      },
      () => {},
    )
    await settle()

    server.send({ type: 'error', kind: 'subscription', id: 's1', error: 'boom' })
    await settle()

    // A stale invalidate for the dropped sub must not fire.
    server.send({ type: 'invalidate', id: 's1' })
    await settle()
    expect(invalidations).toBe(0)

    engine.disconnect()
  })

  test('re-subscribe without onError clears a stale error handler (YW-108)', async () => {
    // Regression (Greptile P1): handlers.set() unconditionally overwrites the
    // invalidate handler, but errorHandlers must be cleared too when the new
    // registrant omits onError. Otherwise a subscribe(id, …, onError) followed by
    // a re-subscribe(id, …) with NO onError (no unsubscribe between) leaves the
    // OLD onError in the map, and the next subscription error for that id fires
    // the stale closure against a subscription the new registrant never wired.
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    const server = harness.server()
    let oldErrors = 0
    // First registration WITH an onError.
    engine.subscribe(
      's1',
      'q',
      {},
      () => {},
      () => {
        oldErrors++
      },
    )
    await settle()

    // Re-subscribe the SAME id WITHOUT an onError and WITHOUT unsubscribing.
    engine.subscribe('s1', 'q', {}, () => {})
    await settle()

    // A subscription error for 's1' must NOT fire the stale first onError.
    server.send({ type: 'error', kind: 'subscription', id: 's1', error: 'boom' })
    await settle()
    expect(oldErrors).toBe(0)

    engine.disconnect()
  })

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
    let socketClosed = 0
    const pipe: EnginePipe = {
      id: 'rejecting',
      send: () => Promise.reject(new Error('send failed')),
      onMessage: () => () => {},
      close: () => {
        socketClosed++
      },
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
    // Async write failure leaves the socket open just like the sync throw —
    // the engine must close the captured socket itself (Codex P2).
    expect(socketClosed).toBe(1)
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

  test('synchronous send throw rejects the call without corrupting engine state', async () => {
    // Regression (Codex P2): the WS adapter encodes the frame inside `send`
    // (e.g. `JSON.stringify(message)`), which throws SYNCHRONOUSLY on a BigInt
    // or cyclic arg. `safeSend` only catches async rejections, so the throw
    // escapes the call() executor. The promise must reject, and call() must
    // delete the pending entry it just added (the no-leak guarantee lives in
    // that `pendingCalls.delete(id)` — verified by reading the diff, since the
    // map is private). This test verifies the two observable consequences: the
    // call rejects with the encode error, and the engine stays fully usable.
    //
    // Hand-rolled pipe: the next `call` send throws once, later sends succeed.
    const sent: ClientMessage[] = []
    // Set (not a single `let`) so TS doesn't narrow the handler to `null` at
    // the call sites — mirrors the close-handler pattern elsewhere in this file.
    const messageHandlers = new Set<(msg: ServerMessage) => void>()
    const deliver = (msg: ServerMessage) => {
      for (const h of Array.from(messageHandlers)) h(msg)
    }
    let throwNextSend = false
    const pipe: EnginePipe = {
      id: 'sync-throw',
      send(message: ClientMessage) {
        if (throwNextSend && message.type === 'call') {
          throwNextSend = false
          // Emulate the adapter's encode step blowing up synchronously.
          throw new TypeError('Do not know how to serialize a BigInt')
        }
        sent.push(message)
      },
      onMessage(handler: (msg: ServerMessage) => void) {
        messageHandlers.add(handler)
        return () => {
          messageHandlers.delete(handler)
        }
      },
      close: () => {},
      onClose: () => () => {},
    }
    const engine = createEngine({ createPipe: () => pipe })
    engine.connect()
    await settle()
    expect(engine.isConnected()).toBe(true)

    // First call: send throws synchronously → promise rejects with the error.
    throwNextSend = true
    const failed = engine.call('path.bigint', {})
    await expect(failed).rejects.toThrow('Do not know how to serialize a BigInt')

    // A stray `result` for the failed call's id (`1`) is an unknown/stale
    // id: a no-op. No crash; the rejected promise stays rejected.
    deliver({ type: 'result', id: '1', data: 'stray' })
    await settle()

    // The engine stays fully usable after a sync throw: the next call resolves
    // end-to-end. Its id is `2` (the seq advanced past the failed call),
    // so ids are never reused.
    const ok = engine.call('path.ok', {})
    await settle()
    const callFrame = sent.find((f) => f.type === 'call') as
      | Extract<ClientMessage, { type: 'call' }>
      | undefined
    expect(callFrame).toBeDefined()
    expect(callFrame!.id).toBe('2')
    deliver({ type: 'result', id: callFrame!.id, data: 'ok' })
    expect(await withTimeout(ok, 'second call after sync throw')).toBe('ok')

    engine.disconnect()
  })

  test('subscription error (kind:subscription) never mis-rejects a pending call — same id (YW-99)', async () => {
    // Spec contract (YW-99): the `error` frame carries a `kind` discriminant.
    // `kind: 'subscription'` must NOT touch pendingCalls even when msg.id matches
    // an in-flight call id. Before YW-99 the engine relied on a reserved `call:`
    // id prefix to keep the keyspaces disjoint; now the tag is self-describing so
    // caller-supplied subscription ids are unconstrained.
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    // A subscription whose id INTENTIONALLY matches the call id below.
    // This is the exact same-id collision scenario YW-99 is designed to handle.
    engine.subscribe('1', 'some.sub', {}, () => {})

    // An in-flight call. Its id will be `'1'` (plain counter).
    const result = engine.call('the.call', {})
    await settle()

    const server = harness.server()
    const callFrame = server.received.find((f) => f.type === 'call') as
      | Extract<ClientMessage, { type: 'call' }>
      | undefined
    expect(callFrame).toBeDefined()
    expect(callFrame!.id).toBe('1')

    // Server sends a subscription error for id `'1'` with kind: 'subscription'.
    // The pending call (also id '1') must NOT be rejected by it.
    server.send({ type: 'error', kind: 'subscription', id: '1', error: 'subscription failed' })
    await settle()

    // Prove the call is still live: not settled by the subscription error.
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

    // The call's real result resolves it normally.
    server.send({ type: 'result', id: callFrame!.id, data: 'call-data' })
    await settle()
    expect(await withTimeout(result, 'kind-discriminant call')).toBe('call-data')

    engine.disconnect()
  })

  test('call error (kind:call) with same id as subscription correctly rejects the call', async () => {
    // Complementary to the subscription-kind test: an error tagged kind:'call'
    // MUST reject the pending call, even if a subscription with the same id exists.
    const harness = makeServerSide()
    const engine = createEngine({ createPipe: harness.createPipe })
    engine.connect()
    await settle()

    // Subscribe with the same id the call will use.
    engine.subscribe('1', 'some.sub', {}, () => {})

    const result = engine.call('the.call', {})
    await settle()

    const server = harness.server()
    const callFrame = server.received.find((f) => f.type === 'call') as
      | Extract<ClientMessage, { type: 'call' }>
      | undefined
    expect(callFrame).toBeDefined()
    expect(callFrame!.id).toBe('1')

    // Server sends a call error — must reject the pending call.
    server.send({ type: 'error', kind: 'call', id: '1', error: 'call failed' })
    await settle()

    await expect(result).rejects.toThrow('call failed')
    engine.disconnect()
  })

  test('backward-compat: error with id and absent kind still rejects the pending call', async () => {
    // Older servers omit `kind`. The client must treat absent kind as 'call'
    // (backward-compatible) so existing RPC error flows keep working.
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

    // Old-server error: no kind field.
    server.send({ type: 'error', id: callFrame!.id, error: 'old server error' })
    await settle()

    await expect(result).rejects.toThrow('old server error')
    engine.disconnect()
  })

  test('control-frame sync send throw closes the connection (does not escape subscribe)', async () => {
    // Regression (CodeRabbit): sendOrClose must catch a SYNCHRONOUS encode throw
    // from the transport and route it through handleClose — not let it propagate
    // out of subscribe()/the connect chain. Before hardening, only call() guarded
    // sync throws; subscribe/unsubscribe/auth rode the bare async-only wrapper.
    const closeHandlers = new Set<(info: CloseInfo) => void>()
    let socketClosed = 0
    const pipe: EnginePipe = {
      id: 'sync-throw-sub',
      send(message: ClientMessage) {
        if (message.type === 'subscribe') {
          // Emulate the adapter's encode step throwing synchronously.
          throw new TypeError('Do not know how to serialize a BigInt')
        }
      },
      onMessage: () => () => {},
      close: () => {
        socketClosed++
      },
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

    // subscribe() must NOT throw — the sync encode failure is absorbed by
    // sendOrClose, which closes the connection instead.
    expect(() => engine.subscribe('s1', 'listTodos', {}, () => {})).not.toThrow()
    await settle()

    // The connection was torn down (handleClose ran), not left in a half state.
    expect(engine.isConnected()).toBe(false)
    // The captured socket was actively closed (Codex P2): a synthesized close
    // has no real close event behind it, so the engine must close the socket
    // itself or it leaks open while scheduleReconnect opens a second.
    expect(socketClosed).toBe(1)
    engine.disconnect()
  })
})
