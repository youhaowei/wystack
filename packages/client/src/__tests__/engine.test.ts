import { describe, expect, test } from 'bun:test'
import {
  createLoopbackPair,
  type ClientMessage,
  type Pipe,
  type ServerMessage,
} from '@wystack/transport'
import { createClientEngine } from '../engine'

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 1000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timeout)
        resolve(value)
      },
      (err) => {
        clearTimeout(timeout)
        reject(err)
      },
    )
  })
}

function waitUntil(
  condition: () => boolean,
  label: string,
  { interval = 10, timeout = 1000 }: { interval?: number; timeout?: number } = {},
): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (condition()) {
          clearInterval(check)
          resolve()
        }
      }, interval)
    }),
    label,
    timeout,
  )
}

function makeHarness() {
  let serverPipe!: Pipe<ClientMessage, ServerMessage>
  const closed = deferred<{ code?: number; reason?: string }>()
  const received: ClientMessage[] = []

  const engine = createClientEngine({
    getToken: () => 'user_123',
    createPipe: () => {
      const [client, server] = createLoopbackPair<ServerMessage, ClientMessage>()
      serverPipe = server
      server.onMessage((message) => {
        received.push(message)
        if (message.type === 'auth') {
          void server.send({ type: 'authenticated' })
        }
        if (message.type === 'subscribe') {
          void server.send({ type: 'subscribed', id: message.id })
        }
      })
      return { pipe: client, closed: closed.promise }
    },
  })

  return { engine, closed, received, getServerPipe: () => serverPipe }
}

describe('ClientEngine', () => {
  test('keeps connect idempotent while pipe creation is pending', async () => {
    const opened = deferred<{
      pipe: Pipe<ServerMessage, ClientMessage>
      closed: Promise<{ code?: number; reason?: string }>
    }>()
    let createPipeCalls = 0

    const engine = createClientEngine({
      requiresAuth: false,
      createPipe: () => {
        createPipeCalls++
        return opened.promise
      },
    })

    engine.connect()
    engine.connect()
    await Promise.resolve()

    expect(createPipeCalls).toBe(1)

    const [client] = createLoopbackPair<ServerMessage, ClientMessage>()
    opened.resolve({ pipe: client, closed: new Promise(() => {}) })

    await waitUntil(() => engine.isConnected(), 'pending connect resolve')
    expect(createPipeCalls).toBe(1)
  })

  test('does not create a pipe after disconnect invalidates token fetch', async () => {
    const token = deferred<string | null>()
    let createPipeCalls = 0

    const engine = createClientEngine({
      getToken: () => token.promise,
      createPipe: () => {
        createPipeCalls++
        const [client] = createLoopbackPair<ServerMessage, ClientMessage>()
        return { pipe: client, closed: new Promise(() => {}) }
      },
    })

    engine.connect()
    engine.disconnect()
    token.resolve('user_123')
    await Promise.resolve()
    await Promise.resolve()

    expect(createPipeCalls).toBe(0)
    expect(engine.isConnected()).toBe(false)
  })

  test('surfaces server error frames through onProtocolError', async () => {
    const [client, server] = createLoopbackPair<ServerMessage, ClientMessage>()
    const protocolError = deferred<unknown>()
    const engine = createClientEngine({
      requiresAuth: false,
      createPipe: () => ({ pipe: client, closed: new Promise(() => {}) }),
      onProtocolError: protocolError.resolve,
    })

    engine.connect()
    await waitUntil(() => engine.isConnected(), 'engine connect')

    await server.send({ type: 'error', id: 'sub1', error: 'No such function' })
    expect(await withTimeout(protocolError.promise, 'protocol error')).toEqual({
      type: 'error',
      id: 'sub1',
      error: 'No such function',
    })
  })

  test('handles rejected pipe close promises without unhandled rejection', async () => {
    const [client] = createLoopbackPair<ServerMessage, ClientMessage>()
    const protocolError = deferred<unknown>()
    let rejectClosed!: (reason?: unknown) => void
    const closed = new Promise<{ code?: number; reason?: string }>((_resolve, reject) => {
      rejectClosed = reject
    })

    const engine = createClientEngine({
      requiresAuth: false,
      reconnectDelayMs: () => 1000,
      createPipe: () => ({ pipe: client, closed }),
      onProtocolError: protocolError.resolve,
    })

    engine.connect()
    await waitUntil(() => engine.isConnected(), 'engine connect')
    rejectClosed(new Error('close failed'))

    const error = await withTimeout(protocolError.promise, 'close rejection')
    expect(error).toBeInstanceOf(Error)
    expect(engine.isConnected()).toBe(false)
    engine.disconnect()
  })

  test('authenticates and flushes buffered subscriptions over a Pipe', async () => {
    const { engine, received } = makeHarness()
    const invalidated = deferred<void>()

    engine.subscribe('sub1', 'listTodos', {}, invalidated.resolve)
    engine.connect()

    await waitUntil(
      () => received.some((message) => message.type === 'subscribe' && message.id === 'sub1'),
      'subscribe flush',
    )

    expect(received[0]).toEqual({ type: 'auth', token: 'user_123' })
    expect(received[1]).toEqual({ type: 'subscribe', id: 'sub1', path: 'listTodos', args: {} })
    expect(engine.isConnected()).toBe(true)
    expect(engine.isAuthenticated()).toBe(true)
  })

  test('correlates invalidate and subscribed messages by subscription id', async () => {
    const subscribed = deferred<string>()
    const [client, server] = createLoopbackPair<ServerMessage, ClientMessage>()
    const invalidated = deferred<void>()

    const engine = createClientEngine({
      requiresAuth: false,
      createPipe: () => ({ pipe: client, closed: new Promise(() => {}) }),
      onSubscribed: subscribed.resolve,
    })

    engine.connect()
    await waitUntil(() => engine.isConnected(), 'engine connect')
    engine.subscribe('sub1', 'listTodos', {}, invalidated.resolve)

    await server.send({ type: 'subscribed', id: 'sub1' })
    await server.send({ type: 'invalidate', id: 'other' })

    expect(await withTimeout(subscribed.promise, 'subscribed')).toBe('sub1')

    let fired = false
    invalidated.promise.then(() => {
      fired = true
    })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(fired).toBe(false)

    await server.send({ type: 'invalidate', id: 'sub1' })
    await withTimeout(invalidated.promise, 'invalidation')
  })

  test('unsubscribes through the pipe and removes the invalidation handler', async () => {
    const { engine, received, getServerPipe } = makeHarness()
    let invalidations = 0

    engine.connect()
    engine.subscribe('sub1', 'listTodos', {}, () => {
      invalidations++
    })

    await waitUntil(
      () => received.some((message) => message.type === 'subscribe'),
      'subscribed before unsubscribe',
    )

    engine.unsubscribe('sub1')
    await waitUntil(
      () => received.some((message) => message.type === 'unsubscribe' && message.id === 'sub1'),
      'unsubscribe send',
    )

    await getServerPipe().send({ type: 'invalidate', id: 'sub1' })
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(invalidations).toBe(0)
  })
})
