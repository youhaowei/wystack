// Engine (Session + Dispatch) over a Pipe — YW-56 / TASK-638.
//
// Drives `attachEngine` over an in-memory loopback pair. The server end runs the
// Engine; the client end sends raw protocol frames and collects server frames.
// Delivery crosses async boundaries (loopback microtask + real PGlite I/O), so
// assertions await `until(...)` for a frame to land, or `flush()` to prove none does.
//
// Coverage maps to the acceptance criteria:
//   - RPC tier over any Pipe (AC #1): call → result for query and mutation.
//   - Auth-handshake parity (AC #2): the parity checklist below.
//   - subscribe → REACTIVITY_NOT_ENABLED when reactive tier not wired (AC #3).
//
// Auth parity checklist (mirrors the shipped routes.ts handshake):
//   1. no-auth server starts authenticated; call works without an auth frame.
//   2. auth-required server: successful handshake → `authenticated`, then call.
//   3. bad token → terminal close (`auth-failed`); no `authenticated` frame.
//   4. anonymous (token:null) strips an inherited Authorization header.
//   5. idempotent ACK: repeat auth frame (and no-auth server) re-ACKs without
//      adopting/overwriting the token.
//   6. double auth frame race → exactly one identity committed.
//   7. malformed first frame pre-auth → terminal close.
//   8. handshake timeout → transient close.

import { describe, test, expect } from 'bun:test'
import { createDb, defineSchema, text, int, boolean } from '@wystack/db'
import {
  createLoopbackPair,
  REACTIVITY_NOT_ENABLED,
  type ClientMessage,
  type ServerMessage,
} from '@wystack/transport'
import { createWyStack } from '../create'
import { query, mutation } from '../functions'
import { attachEngine, type AttachEngineOptions } from '../engine'

const schema = defineSchema({
  todos: { id: int.primaryKey(), title: text, done: boolean },
})

async function makeApp() {
  const db = await createDb({ dev: 'pglite://' })
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  return createWyStack({
    db,
    functions: {
      listTodos: query({ args: {}, handler: async (ctx) => ctx.db.from(schema.todos).all() }),
      whoami: query({ args: {}, handler: async (ctx) => ({ userId: ctx.userId ?? null }) }),
      addTodo: mutation({
        args: { title: text },
        handler: async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ title: args.title, done: false }),
      }),
      boom: query({
        args: {},
        handler: async () => {
          throw new Error('kaboom')
        },
      }),
    },
  })
}

/**
 * Wait until `predicate` holds, polling across macrotask ticks. Loopback
 * delivers on a microtask boundary, but `app.call` awaits real PGlite I/O
 * (timers), so a fixed microtask drain is not enough — we poll until the
 * server frame lands or we time out.
 */
async function until(predicate: () => boolean, label: string, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`until(${label}) timed out`)
    await new Promise((r) => setTimeout(r, 1))
  }
}

/** Drain a few macrotask ticks — for asserting that NOTHING arrives. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20))
}

/**
 * Wire a client loopback end to an Engine-attached server end. Returns the
 * client-side controls: `send` a frame, the collected `received` frames, the
 * collected `closeReasons` the Engine emitted, and whether the pipe closed.
 */
async function harness(opts?: Partial<AttachEngineOptions>) {
  const app = await makeApp()
  // Client sends ClientMessage, receives ServerMessage; server end is mirrored.
  const [clientPipe, serverPipe] = createLoopbackPair<ServerMessage, ClientMessage>()

  const received: ServerMessage[] = []
  clientPipe.onMessage((m) => received.push(m))

  const closeReasons: string[] = []
  const handle = attachEngine(serverPipe, {
    app,
    onClose: (reason) => closeReasons.push(reason),
    ...opts,
  })

  return {
    handle,
    received,
    closeReasons,
    send: (msg: ClientMessage) => clientPipe.send(msg),
    detach: () => handle.detach(),
  }
}

describe('Engine — RPC tier (AC #1)', () => {
  test('no-auth server: call to a query returns a result without an auth frame', async () => {
    const h = await harness()
    h.send({ type: 'call', id: 'c1', path: 'listTodos', args: {} })
    await until(() => h.received.length > 0, 'result')

    expect(h.received).toEqual([{ type: 'result', id: 'c1', data: [] }])
    expect(h.handle.session.authenticated).toBe(true)
  })

  test('call to a mutation returns the result (tablesWritten dropped — no reactive tier)', async () => {
    const h = await harness()
    h.send({ type: 'call', id: 'm1', path: 'addTodo', args: { title: 'milk' } })
    await until(() => h.received.length > 0, 'result')

    const result = h.received.find((m) => m.type === 'result')
    expect(result).toBeDefined()
    expect(h.received.every((m) => m.type !== 'error')).toBe(true)
  })

  test('call to an unknown function → error frame carrying the call id', async () => {
    const h = await harness()
    h.send({ type: 'call', id: 'c2', path: 'nope', args: {} })
    await until(() => h.received.length > 0, 'error')

    expect(h.received).toEqual([{ type: 'error', id: 'c2', error: 'Unknown function: nope' }])
  })

  test('call whose args fail validation → error frame with issues', async () => {
    const h = await harness()
    // addTodo requires a string `title`; pass a number.
    h.send({ type: 'call', id: 'c3', path: 'addTodo', args: { title: 123 } })
    await until(() => h.received.length > 0, 'error')

    const err = h.received.find((m) => m.type === 'error')
    expect(err).toBeDefined()
    expect(err && 'id' in err && err.id).toBe('c3')
    expect(err && 'issues' in err && Array.isArray(err.issues)).toBe(true)
  })

  test('handler throw → error frame carrying the message and id', async () => {
    const h = await harness()
    h.send({ type: 'call', id: 'c4', path: 'boom', args: {} })
    await until(() => h.received.length > 0, 'error')

    expect(h.received).toEqual([{ type: 'error', id: 'c4', error: 'kaboom' }])
  })
})

describe('Engine — auth handshake parity (AC #2)', () => {
  test('auth-required server: successful handshake → authenticated, then call works', async () => {
    const h = await harness({ resolveContext: async () => ({ userId: 'u1' }) })
    expect(h.handle.session.authenticated).toBe(false)

    h.send({ type: 'auth', token: 'good' })
    await until(() => h.received.length > 0, 'authenticated')
    expect(h.received).toEqual([{ type: 'authenticated' }])
    expect(h.handle.session.authenticated).toBe(true)

    h.send({ type: 'call', id: 'c1', path: 'whoami', args: {} })
    await until(() => h.received.length > 1, 'result')
    expect(h.received.at(-1)).toEqual({ type: 'result', id: 'c1', data: { userId: 'u1' } })
  })

  test('bad token → terminal close (auth-failed), no authenticated frame', async () => {
    const h = await harness({
      resolveContext: async () => {
        throw new Error('invalid token')
      },
    })
    h.send({ type: 'auth', token: 'bad' })
    await until(() => h.closeReasons.length > 0, 'close')

    expect(h.closeReasons).toEqual(['auth-failed'])
    expect(h.received).toEqual([])
    expect(h.handle.session.authenticated).toBe(false)
  })

  test('anonymous (token:null) strips an inherited Authorization header', async () => {
    const seen: { auth: string | null }[] = []
    const base = new Request('wystack://pipe', {
      headers: { authorization: 'Bearer leaked' },
    })
    const h = await harness({
      baseRequest: base,
      resolveContext: async (req) => {
        seen.push({ auth: req.headers.get('authorization') })
        return {}
      },
    })

    h.send({ type: 'auth', token: null })
    await until(() => h.received.length > 0, 'authenticated')
    // The leaked header must be stripped — the auth frame is the sole identity.
    expect(seen).toEqual([{ auth: null }])
    expect(h.received).toEqual([{ type: 'authenticated' }])
  })

  test('non-null token layers Bearer over the base request', async () => {
    const seen: { auth: string | null }[] = []
    const h = await harness({
      resolveContext: async (req) => {
        seen.push({ auth: req.headers.get('authorization') })
        return {}
      },
    })
    h.send({ type: 'auth', token: 'tok123' })
    await until(() => seen.length > 0, 'resolve')
    expect(seen).toEqual([{ auth: 'Bearer tok123' }])
  })

  // Parity regression: routes.ts uses a LENIENT envelope parse then coerces a
  // missing / non-string / empty token to null (anonymous). The engine must do
  // the same — NOT route the auth frame through the strict transport parser,
  // which would reject these shapes and terminally close a client routes.ts
  // authenticates. Each case below would have closed `auth-failed` before the
  // envelope-then-coerce fix.
  test('auth frame with a MISSING token coerces to anonymous (not terminal close)', async () => {
    const seen: { auth: string | null }[] = []
    const base = new Request('wystack://pipe', { headers: { authorization: 'Bearer leaked' } })
    const h = await harness({
      baseRequest: base,
      resolveContext: async (req) => {
        seen.push({ auth: req.headers.get('authorization') })
        return {}
      },
    })
    // No `token` field at all — a plausible anonymous client.
    h.send({ type: 'auth' } as unknown as ClientMessage)
    await until(() => h.received.length > 0, 'authenticated')
    expect(seen).toEqual([{ auth: null }]) // stripped → anonymous
    expect(h.received).toEqual([{ type: 'authenticated' }])
    expect(h.closeReasons).toEqual([]) // NOT terminally closed
  })

  test('auth frame with a NON-STRING token coerces to anonymous (not terminal close)', async () => {
    const seen: { auth: string | null }[] = []
    const h = await harness({
      resolveContext: async (req) => {
        seen.push({ auth: req.headers.get('authorization') })
        return {}
      },
    })
    h.send({ type: 'auth', token: 123 } as unknown as ClientMessage)
    await until(() => h.received.length > 0, 'authenticated')
    expect(seen).toEqual([{ auth: null }])
    expect(h.received).toEqual([{ type: 'authenticated' }])
    expect(h.closeReasons).toEqual([])
  })

  test('auth frame with an EMPTY-STRING token coerces to anonymous (strips Authorization)', async () => {
    // The sole non-null string that must coerce to anonymous — guards the
    // `.length > 0` predicate against a `token != null ? Bearer : strip` refactor
    // that would leak an empty `Bearer ` header.
    const seen: { auth: string | null }[] = []
    const base = new Request('wystack://pipe', { headers: { authorization: 'Bearer leaked' } })
    const h = await harness({
      baseRequest: base,
      resolveContext: async (req) => {
        seen.push({ auth: req.headers.get('authorization') })
        return {}
      },
    })
    h.send({ type: 'auth', token: '' })
    await until(() => h.received.length > 0, 'authenticated')
    expect(seen).toEqual([{ auth: null }]) // empty string → stripped, not `Bearer `
    expect(h.received).toEqual([{ type: 'authenticated' }])
  })

  test('no-auth server: an auth frame gets an idempotent ACK without adopting a token', async () => {
    const h = await harness() // no resolveContext → starts authenticated
    h.send({ type: 'auth', token: 'ignored' })
    await until(() => h.received.length > 0, 'ack')

    expect(h.received).toEqual([{ type: 'authenticated' }])
    // Token never adopted on a trusted transport.
    expect(h.handle.session.token).toBeNull()
  })

  test('repeat auth frame → idempotent ACK, token unchanged', async () => {
    const h = await harness({ resolveContext: async () => ({ userId: 'u1' }) })
    h.send({ type: 'auth', token: 'first' })
    await until(() => h.received.length > 0, 'first ack')
    h.send({ type: 'auth', token: 'second' })
    await until(() => h.received.length > 1, 'second ack')

    expect(h.received).toEqual([{ type: 'authenticated' }, { type: 'authenticated' }])
    // The winning identity's token is not swapped by the later frame.
    expect(h.handle.session.token).toBe('first')
  })

  test('double auth frame race → exactly one identity committed', async () => {
    const h = await harness({ resolveContext: async () => ({ userId: 'u1' }) })
    // Fire two frames before either resolves — both pass the pre-await gate.
    h.send({ type: 'auth', token: 'A' })
    h.send({ type: 'auth', token: 'B' })
    await until(() => h.received.filter((m) => m.type === 'authenticated').length >= 2, 'two acks')

    // Both frames ACK (one commits, one idempotent), but only one token sticks.
    const acks = h.received.filter((m) => m.type === 'authenticated')
    expect(acks.length).toBe(2)
    // Loopback delivery is deterministic: A's resolveContext is queued first and
    // commits first; B's continuation then sees `authenticated` and must take the
    // idempotent path WITHOUT clobbering A's token. Asserting `'A'` (not "either")
    // is what catches a loser-clobbers-winner regression.
    expect(h.handle.session.token).toBe('A')
  })

  test('malformed first frame pre-auth → terminal close', async () => {
    const h = await harness({ resolveContext: async () => ({}) })
    // Send a structurally invalid frame (unknown type) before authenticating.
    h.send({ type: 'garbage' } as unknown as ClientMessage)
    await flush()

    expect(h.closeReasons).toEqual(['auth-failed'])
    expect(h.received).toEqual([])
  })

  test('non-auth first frame pre-auth → terminal close', async () => {
    const h = await harness({ resolveContext: async () => ({}) })
    h.send({ type: 'call', id: 'c1', path: 'listTodos', args: {} })
    await flush()

    expect(h.closeReasons).toEqual(['auth-failed'])
  })

  test('handshake timeout → transient close', async () => {
    const h = await harness({ resolveContext: async () => ({}), authTimeoutMs: 10 })
    // Never send an auth frame; wait past the timer.
    await new Promise((r) => setTimeout(r, 30))
    expect(h.closeReasons).toEqual(['transient'])
  })

  test('no-auth server arms no handshake timer', async () => {
    const h = await harness({ authTimeoutMs: 10 })
    await new Promise((r) => setTimeout(r, 30))
    expect(h.closeReasons).toEqual([])
  })

  test('committing-ack send failure → transient close (parity with routes.ts 4002)', async () => {
    // A custom Pipe whose `send` rejects: auth resolves successfully, but the
    // transport dies before the `authenticated` ack lands. Shipped routes.ts
    // closes 4002 here (network flake, not auth failure) so the client retries.
    const app = await makeApp()
    const handlers = new Set<(m: unknown) => void>()
    const closeReasons: string[] = []
    const failingPipe = {
      id: 'failing',
      send: async () => {
        throw new Error('transport gone')
      },
      onMessage: (h: (m: unknown) => void) => {
        handlers.add(h)
        return () => handlers.delete(h)
      },
      close: () => {},
    }
    attachEngine(failingPipe, {
      app,
      resolveContext: async () => ({ userId: 'u1' }),
      onClose: (reason) => closeReasons.push(reason),
    })

    for (const h of handlers) h({ type: 'auth', token: 'good' })
    await until(() => closeReasons.length > 0, 'transient close')
    expect(closeReasons).toEqual(['transient'])
  })
})

describe('Engine — reactive tier opt-in (AC #3)', () => {
  test('subscribe on an RPC-only server → error{REACTIVITY_NOT_ENABLED}', async () => {
    const h = await harness()
    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await flush()

    expect(h.received).toEqual([{ type: 'error', id: 's1', error: REACTIVITY_NOT_ENABLED }])
  })

  test('unsubscribe on an RPC-only server is tolerated silently', async () => {
    const h = await harness()
    h.send({ type: 'unsubscribe', id: 's1' })
    await flush()

    expect(h.received).toEqual([])
  })

  test('post-auth malformed frame → error frame, connection stays open', async () => {
    const h = await harness() // authenticated (no-auth server)
    h.send({ type: 'whatever' } as unknown as ClientMessage)
    await flush()

    expect(h.received).toEqual([{ type: 'error', error: 'invalid message' }])
    expect(h.closeReasons).toEqual([]) // not closed
  })
})

describe('Engine — teardown', () => {
  test('detach closes the pipe and is idempotent', async () => {
    const h = await harness()
    h.detach()
    h.detach() // second call must not throw
    // After detach, further frames produce nothing.
    h.send({ type: 'call', id: 'c1', path: 'listTodos', args: {} })
    await flush()
    expect(h.received).toEqual([])
  })
})
