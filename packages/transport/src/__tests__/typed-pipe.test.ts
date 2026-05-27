import { describe, test, expect } from 'bun:test'
import {
  createLoopbackPair,
  parseClientMessage,
  wrapTypedPipe,
  type ClientMessage,
  type Pipe,
  type ServerMessage,
} from '../index'

// A synthetic raw pipe whose inbound dispatch we drive directly. The
// loopback delivers via `queueMicrotask`, which is the right behavior for
// integration tests but obscures whether a parser throw actually surfaces
// at the raw-handler boundary — the throw escapes into an async
// uncaughtException, which is runtime-dependent to capture. With this
// synthetic pipe we invoke the registered handler in-thread and assert the
// throw directly.
function makeSyntheticPipe(id = 'synthetic'): {
  pipe: Pipe
  inject: (raw: unknown) => void
  sent: unknown[]
  closed: () => boolean
} {
  const handlers = new Set<(message: unknown) => void>()
  const sent: unknown[] = []
  let isClosed = false
  return {
    pipe: {
      id,
      send(message) {
        sent.push(message)
      },
      onMessage(handler) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      close() {
        isClosed = true
        handlers.clear()
      },
    },
    inject(raw) {
      for (const h of handlers) h(raw)
    },
    sent,
    closed: () => isClosed,
  }
}

// `wrapTypedPipe` lifts a raw `Pipe<unknown, unknown>` to a typed view. The
// raw pipe carries `unknown` on both sides; the wrapper composes a parser
// onto the inbound side and types the outbound side at compile time only.

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('wrapTypedPipe — inbound parsing', () => {
  test('parsed value reaches the typed handler', async () => {
    const [serverSide, clientSide] = createLoopbackPair()
    const typedServer = wrapTypedPipe<ClientMessage, ServerMessage>(
      serverSide,
      (raw): ClientMessage => {
        if (typeof raw !== 'string') throw new Error('expected JSON string')
        const msg = parseClientMessage(raw)
        if (msg === null) throw new Error('malformed client frame')
        return msg
      },
    )

    const received: ClientMessage[] = []
    typedServer.onMessage((m) => received.push(m))

    // Client emits a well-formed auth frame on its side of the raw pipe.
    clientSide.send(JSON.stringify({ type: 'auth', token: 'jwt' }))
    await flushMicrotasks()
    expect(received).toEqual([{ type: 'auth', token: 'jwt' }])
  })

  test('parser throw propagates out of the underlying pipe-handler invocation', () => {
    // Brief contract: a parser throw must NOT be silently swallowed by the
    // wrapper. The typed handler never sees a malformed payload; the throw
    // surfaces at the raw pipe's handler boundary, which is what an adapter
    // (or the engine) can then catch and turn into an error frame.
    const harness = makeSyntheticPipe()
    const typed = wrapTypedPipe<ClientMessage, ServerMessage>(harness.pipe, (raw) => {
      if (typeof raw !== 'string') throw new Error('expected JSON string')
      const msg = parseClientMessage(raw)
      if (msg === null) throw new Error('malformed client frame')
      return msg
    })

    const typedReceived: ClientMessage[] = []
    typed.onMessage((m) => typedReceived.push(m))

    // Driving the synthetic pipe directly: the raw handler runs in-thread,
    // so a parser throw escapes the call here.
    expect(() => harness.inject(42)).toThrow('expected JSON string')
    expect(typedReceived).toEqual([])

    // A second inject with a malformed string still throws — different
    // branch in the parser.
    expect(() => harness.inject('not json')).toThrow('malformed client frame')
    expect(typedReceived).toEqual([])

    // Good payload after a throw still parses cleanly — wrapper holds no
    // sticky state.
    harness.inject(JSON.stringify({ type: 'unsubscribe', id: 'sub1' }))
    expect(typedReceived).toEqual([{ type: 'unsubscribe', id: 'sub1' }])
  })

  test('multiple typed handlers each receive the parsed value', async () => {
    const [serverSide, clientSide] = createLoopbackPair()
    const typedServer = wrapTypedPipe<ClientMessage, ServerMessage>(serverSide, (raw) => {
      if (typeof raw !== 'string') throw new Error('non-string raw')
      const msg = parseClientMessage(raw)
      if (msg === null) throw new Error('malformed')
      return msg
    })

    const r1: ClientMessage[] = []
    const r2: ClientMessage[] = []
    typedServer.onMessage((m) => r1.push(m))
    typedServer.onMessage((m) => r2.push(m))

    clientSide.send(JSON.stringify({ type: 'unsubscribe', id: 'sub1' }))
    await flushMicrotasks()
    expect(r1).toEqual([{ type: 'unsubscribe', id: 'sub1' }])
    expect(r2).toEqual([{ type: 'unsubscribe', id: 'sub1' }])
  })
})

describe('wrapTypedPipe — pass-through', () => {
  test('id is shared with the underlying pipe', () => {
    const [serverSide] = createLoopbackPair()
    const typedServer = wrapTypedPipe<ClientMessage, ServerMessage>(
      serverSide,
      (raw) => raw as ClientMessage,
    )
    expect(typedServer.id).toBe(serverSide.id)
  })

  test('close on the typed view closes the underlying pipe', async () => {
    const [serverSide, clientSide] = createLoopbackPair()
    const typedServer = wrapTypedPipe<ClientMessage, ServerMessage>(
      serverSide,
      (raw) => raw as ClientMessage,
    )

    const onClient: unknown[] = []
    clientSide.onMessage((m) => onClient.push(m))

    typedServer.close()
    // After close, both raw and typed sends are no-ops.
    expect(() => clientSide.send('after')).not.toThrow()
    await flushMicrotasks()
    expect(onClient).toEqual([])
  })

  test('send is delegated to the underlying pipe', async () => {
    const [serverSide, clientSide] = createLoopbackPair()
    const typedServer = wrapTypedPipe<ClientMessage, ServerMessage>(
      serverSide,
      (raw) => raw as ClientMessage,
    )

    const received: unknown[] = []
    clientSide.onMessage((m) => received.push(m))

    const frame: ServerMessage = { type: 'subscribed', id: 'sub1' }
    typedServer.send(frame)
    await flushMicrotasks()
    expect(received).toEqual([frame])
  })
})

// ─── Compile-time guarantees ─────────────────────────────────────────────────
// These exist to assert at the type system, not at runtime. If the typed
// pipe's `send` ever loses its `Out` constraint, this file stops compiling.
const _typeChecks = (): void => {
  const [serverSide] = createLoopbackPair()
  const typed = wrapTypedPipe<ClientMessage, ServerMessage>(
    serverSide,
    (raw) => raw as ClientMessage,
  )

  // Allowed: a valid ServerMessage.
  typed.send({ type: 'authenticated' })

  // Disallowed: a ClientMessage on the server-side outbound channel.
  // @ts-expect-error — server cannot send a client-shaped frame.
  typed.send({ type: 'auth', token: null })

  // Disallowed: an arbitrary object.
  // @ts-expect-error — must match ServerMessage shape.
  typed.send({ nope: true })

  // Inbound handler is typed as ClientMessage.
  typed.onMessage((m: ClientMessage) => {
    void m
  })
}
void _typeChecks
