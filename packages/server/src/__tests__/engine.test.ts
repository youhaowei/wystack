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
//
// Beyond parity (new behavior, not present in routes.ts's original handshake):
//   9. identity-provider outage → transient close, NOT auth-failed. A key server
//      that is down is not a bad credential, and 4001 tells clients not to retry.

import { describe, test, expect } from 'bun:test'
import { IdentityProviderUnavailableError } from '@wystack/identity'
import { createDb, defineSchema, text, int, boolean } from '@wystack/db'
import {
  createLoopbackPair,
  REACTIVITY_NOT_ENABLED,
  type ClientMessage,
  type ServerMessage,
} from '@wystack/transport'
import { ValidationError } from '../validation'
import { AuthenticationRequiredError } from '../functions'
import {
  attachEngine,
  type AttachEngineOptions,
  createInMemorySubscriptionStore,
  createInvalidationRouter,
} from '../engine'
import { defineApp } from '../define-app'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const schema = defineSchema({
  todos: { id: int.primaryKey(), title: text, done: boolean },
})

const deniedPermission = {
  id: 'todos.read',
  description: 'Read todos',
  check: () => false,
}

function protectListTodos(app: Awaited<ReturnType<typeof makeApp>>): void {
  app.functions.set(
    'listTodos',
    wy.procedure
      .authorize(deniedPermission)
      .input({})
      .query(async (ctx) => ctx.db.from(schema.todos).all()),
  )
}

async function makeApp() {
  const db = await createDb({ dev: 'pglite://' })
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  return wy.build({
    db,
    functions: {
      listTodos: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.todos).all()),
      whoami: wy.procedure.input({}).query(async (ctx) => ({ userId: ctx.userId ?? null })),
      todoByTitle: wy.procedure
        .input({ title: text })
        .query(async (ctx) => ctx.db.from(schema.todos).all()),
      addTodo: wy.procedure
        .input({ title: text })
        .mutation(async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ title: args.title, done: false }),
        ),
      boom: wy.procedure.input({}).query(async () => {
        throw new Error('kaboom')
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

    expect(h.received).toEqual([
      { type: 'error', kind: 'call', id: 'c2', error: 'Unknown function: nope' },
    ])
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

    expect(h.received).toEqual([{ type: 'error', kind: 'call', id: 'c4', error: 'kaboom' }])
  })

  test('call permission failure emits an error frame carrying the call id', async () => {
    const app = await makeApp()
    protectListTodos(app)
    const [clientPipe, serverPipe] = createLoopbackPair<ServerMessage, ClientMessage>()
    const received: ServerMessage[] = []
    clientPipe.onMessage((message) => received.push(message))
    attachEngine(serverPipe, { app })

    clientPipe.send({ type: 'call', id: 'c5', path: 'listTodos', args: {} })
    await until(() => received.length > 0, 'permission error')

    expect(received).toEqual([
      {
        type: 'error',
        kind: 'call',
        id: 'c5',
        error: 'Permission denied: todos.read',
      },
    ])
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

  test('identity provider outage → transient close, not auth-failed', async () => {
    // A key server that is down is not a bad credential. Closing `auth-failed` maps to
    // WS 4001, documented as "client does not retry", so a transient upstream incident
    // would latch a terminal auth failure that resolves only by user action.
    const warnings: string[] = []
    const realWarn = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(' '))

    // `finally`, not a trailing restore: a failing assertion below would otherwise
    // abandon the patched `console.warn` and silently swallow output for every later
    // test in this file, turning one red test into a confusing suite.
    try {
      const h = await harness({
        resolveContext: async () => {
          throw new IdentityProviderUnavailableError('key set unreachable')
        },
      })
      h.send({ type: 'auth', token: 'good' })
      await until(() => h.closeReasons.length > 0, 'close')

      expect(h.closeReasons).toEqual(['transient'])
      expect(h.handle.session.authenticated).toBe(false)

      // The log line is the only signal this path emits — the HTTP 503 path logs
      // nothing at all — so a hardcoded "auth failed" here would misattribute the
      // outage on the one surface an operator greps mid-incident.
      expect(warnings.some((line) => line.includes('transient'))).toBe(true)
      expect(warnings.some((line) => line.includes('auth failed'))).toBe(false)
    } finally {
      console.warn = realWarn
    }
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

  test('valid-then-invalid auth race: loser must NOT close the authenticated connection', async () => {
    // Frame A carries a valid token, frame B an invalid one. Both pass the
    // pre-await gate; A authenticates first, then B's resolveContext rejects.
    // B's failure path must re-check `authenticated` and idempotent-ACK rather
    // than tear down A's live connection (regression: catch returned auth-failed
    // unconditionally). Parity with routes.ts:284.
    const h = await harness({
      resolveContext: async (req) => {
        if (req.headers.get('authorization') === 'Bearer good') return { userId: 'u1' }
        throw new Error('invalid token')
      },
    })
    h.send({ type: 'auth', token: 'good' })
    h.send({ type: 'auth', token: 'bad' })
    await until(() => h.received.filter((m) => m.type === 'authenticated').length >= 2, 'two acks')

    // Two ACKs (winner + idempotent loser), token stays the winner's, NOT closed.
    expect(h.received.filter((m) => m.type === 'authenticated').length).toBe(2)
    expect(h.handle.session.token).toBe('good')
    expect(h.closeReasons).toEqual([])
    expect(h.handle.session.authenticated).toBe(true)
  })

  test('malformed first frame pre-auth → terminal close', async () => {
    const h = await harness({ resolveContext: async () => ({}) })
    // Send a structurally invalid frame (unknown type) before authenticating.
    h.send({ type: 'garbage' } as unknown as ClientMessage)
    await flush()

    expect(h.closeReasons).toEqual(['auth-failed'])
    expect(h.received).toEqual([])
  })

  test('non-serializable frame (BigInt) is treated as invalid, not a crash', async () => {
    // JSON.stringify throws on a BigInt; the handler must route it through the
    // invalid-frame path (terminal close pre-auth) rather than throw out of the
    // inbound callback. Pre-auth here → auth-failed.
    const h = await harness({ resolveContext: async () => ({}) })
    h.send({ type: 'call', id: 'c1', n: 1n } as unknown as ClientMessage)
    await flush()
    expect(h.closeReasons).toEqual(['auth-failed'])
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

    expect(h.received).toEqual([
      {
        type: 'error',
        kind: 'subscription',
        id: 's1',
        retryable: false,
        error: REACTIVITY_NOT_ENABLED,
      },
    ])
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

  test('post-auth non-serializable frame (BigInt) → error frame, stays open (no crash)', async () => {
    const h = await harness() // authenticated (no-auth server)
    h.send({ type: 'call', id: 'c1', n: 1n } as unknown as ClientMessage)
    await flush()

    expect(h.received).toEqual([{ type: 'error', error: 'invalid message' }])
    expect(h.closeReasons).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Reactive-tier harness helpers
// ---------------------------------------------------------------------------

/**
 * Create a shared (store, source) pair plus the single router, then attach
 * one or more engine connections to the same store. Returns per-connection
 * send/received controls plus the shared emit handle for triggering
 * invalidations from "outside" (simulating a mutation on another connection).
 */
function makeReactiveShared(app: Awaited<ReturnType<typeof makeApp>>) {
  const subscriptionStore = createInMemorySubscriptionStore()

  // Single router — NOT per-connection — wired to the APP's source. `app.call`
  // fuses invalidation there, and `app.emit` drives it from "outside" (a
  // runHandler-path writer, or a test simulating a write on another connection).
  createInvalidationRouter({
    source: app.invalidationSource,
    store: subscriptionStore,
    recompute: async (entry) => {
      const { tablesRead } = await app.call(
        entry.functionPath,
        entry.args,
        entry.context as Record<string, unknown>,
      )
      return { tablesRead }
    },
  })

  return { subscriptionStore, publishInvalidation: app.emit }
}

/**
 * Wire a single reactive-enabled loopback connection. Returns the same shape
 * as `harness` plus the shared `publishInvalidation` for driving invalidations
 * from a test.
 */
async function reactiveHarness(
  opts?: Partial<AttachEngineOptions>,
  configureApp?: (app: Awaited<ReturnType<typeof makeApp>>) => void,
) {
  const app = await makeApp()
  configureApp?.(app)
  const { subscriptionStore, publishInvalidation } = makeReactiveShared(app)

  const [clientPipe, serverPipe] = createLoopbackPair<ServerMessage, ClientMessage>()
  const received: ServerMessage[] = []
  clientPipe.onMessage((m) => received.push(m))

  const closeReasons: string[] = []
  const handle = attachEngine(serverPipe, {
    app,
    subscriptionStore,
    onClose: (reason) => closeReasons.push(reason),
    ...opts,
  })

  return {
    app,
    handle,
    received,
    closeReasons,
    subscriptionStore,
    publishInvalidation,
    send: (msg: ClientMessage) => clientPipe.send(msg),
    detach: () => handle.detach(),
  }
}

describe('Engine — reactive tier enabled (AC #3 ext)', () => {
  test('subscribe → subscribed ack when reactive tier is wired', async () => {
    const h = await reactiveHarness()
    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'subscribed'), 'subscribed')

    const ack = h.received.find((m) => m.type === 'subscribed')
    expect(ack).toBeDefined()
    expect(ack && 'id' in ack && ack.id).toBe('s1')
    expect(h.subscriptionStore.size()).toBe(1)
  })

  test('subscribe to unknown query → error frame (not a crash)', async () => {
    const h = await reactiveHarness()
    h.send({ type: 'subscribe', id: 's1', path: 'nonExistent', args: {} })
    await until(() => h.received.length > 0, 'error')

    expect(h.received).toEqual([
      {
        type: 'error',
        kind: 'subscription',
        id: 's1',
        retryable: false,
        error: 'Unknown query: nonExistent',
      },
    ])
    expect(h.subscriptionStore.size()).toBe(0)
  })

  test('subscribe context failure emits retryable subscription error', async () => {
    let callCount = 0
    const h = await reactiveHarness({
      resolveContext: async () => {
        callCount++
        if (callCount > 1) throw new Error('context temporarily unavailable')
        return {}
      },
    })

    h.send({ type: 'auth', token: 'tok' })
    await until(() => h.received.some((m) => m.type === 'authenticated'), 'authenticated')

    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'error'), 'context error')

    expect(h.received[h.received.length - 1]).toEqual({
      type: 'error',
      kind: 'subscription',
      id: 's1',
      retryable: true,
      error: 'context temporarily unavailable',
    })
    expect(h.subscriptionStore.size()).toBe(0)
  })

  test('subscribe context validation failure emits durable subscription error with issues', async () => {
    // Context can be validated before a subscription is registered. A validation
    // failure is durable caller/input state, unlike a temporary context outage,
    // so the client must receive issues and must not retry it as transient.
    const issues = [{ code: 'custom' as const, path: ['token'], message: 'Required' }]
    let callCount = 0
    const h = await reactiveHarness({
      resolveContext: async () => {
        callCount++
        if (callCount > 1) throw new ValidationError(issues)
        return {}
      },
    })

    h.send({ type: 'auth', token: 'tok' })
    await until(() => h.received.some((m) => m.type === 'authenticated'), 'authenticated')

    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'error'), 'context validation error')

    expect(h.received[h.received.length - 1]).toEqual({
      type: 'error',
      kind: 'subscription',
      id: 's1',
      retryable: false,
      error: 'Validation failed: token: Required',
      issues,
    })
    expect(h.subscriptionStore.size()).toBe(0)
  })

  test('subscribe context auth failure emits durable subscription error', async () => {
    // The counterpart to the outage case above, and the reason `retryable` cannot simply
    // track "did resolveContext throw". Both arrive here as a rejected context, but an
    // expired or missing credential fails identically however many times the client
    // resends it, while a provider outage clears on its own. Reporting this one as
    // retryable puts the client in a silent reconnect loop against a subscription that
    // can never succeed until the user re-authenticates — and the loop hides the very
    // signal that would tell them to.
    let callCount = 0
    const h = await reactiveHarness({
      resolveContext: async () => {
        callCount++
        if (callCount > 1) throw new AuthenticationRequiredError()
        return {}
      },
    })

    h.send({ type: 'auth', token: 'tok' })
    await until(() => h.received.some((m) => m.type === 'authenticated'), 'authenticated')

    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'error'), 'context auth error')

    expect(h.received[h.received.length - 1]).toEqual({
      type: 'error',
      kind: 'subscription',
      id: 's1',
      retryable: false,
      error: 'Authentication required',
    })
    expect(h.subscriptionStore.size()).toBe(0)
  })

  test('subscribe query failure emits retryable subscription error', async () => {
    const h = await reactiveHarness()
    h.send({ type: 'subscribe', id: 's1', path: 'boom', args: {} })
    await until(() => h.received.some((m) => m.type === 'error'), 'query error')

    expect(h.received).toEqual([
      {
        type: 'error',
        kind: 'subscription',
        id: 's1',
        retryable: true,
        error: 'kaboom',
      },
    ])
    expect(h.subscriptionStore.size()).toBe(0)
  })

  test('subscribe permission failure emits a durable subscription error', async () => {
    const h = await reactiveHarness(undefined, protectListTodos)
    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'error'), 'permission error')

    expect(h.received).toEqual([
      {
        type: 'error',
        kind: 'subscription',
        id: 's1',
        retryable: false,
        error: 'Permission denied: todos.read',
      },
    ])
    expect(h.subscriptionStore.size()).toBe(0)
  })

  test('subscribe validation failure emits durable subscription error with issues', async () => {
    const h = await reactiveHarness()
    h.send({ type: 'subscribe', id: 's1', path: 'todoByTitle', args: {} })
    await until(() => h.received.some((m) => m.type === 'error'), 'validation error')

    const err = h.received[0]
    expect(err).toMatchObject({
      type: 'error',
      kind: 'subscription',
      id: 's1',
      retryable: false,
    })
    expect(err && 'error' in err && err.error).toContain('Validation failed')
    expect(err && 'issues' in err && Array.isArray(err.issues)).toBe(true)
    expect(h.subscriptionStore.size()).toBe(0)
  })

  test('mutation → subscribed connection receives invalidate frame', async () => {
    const h = await reactiveHarness()
    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'subscribed'), 'subscribed')

    h.send({ type: 'call', id: 'c1', path: 'addTodo', args: { title: 'test' } })
    await until(() => h.received.some((m) => m.type === 'invalidate'), 'invalidate')

    const inv = h.received.find((m) => m.type === 'invalidate')
    expect(inv).toBeDefined()
    expect(inv && 'id' in inv && inv.id).toBe('s1')
  })

  test('unsubscribe removes entry from store and stops future invalidations', async () => {
    const h = await reactiveHarness()
    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'subscribed'), 'subscribed')
    expect(h.subscriptionStore.size()).toBe(1)

    h.send({ type: 'unsubscribe', id: 's1' })
    await flush()
    expect(h.subscriptionStore.size()).toBe(0)

    const countBefore = h.received.length
    h.send({ type: 'call', id: 'c1', path: 'addTodo', args: { title: 'test' } })
    await until(() => h.received.some((m) => m.type === 'result'), 'result after unsub')
    await flush()

    // No invalidate frame should have arrived after unsubscribe.
    const newFrames = h.received.slice(countBefore)
    expect(newFrames.every((m) => m.type !== 'invalidate')).toBe(true)
  })

  test('detach removes all subscriptions and stops future invalidations', async () => {
    const h = await reactiveHarness()
    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'subscribed'), 'subscribed')
    expect(h.subscriptionStore.size()).toBe(1)

    h.detach()
    await flush()

    expect(h.subscriptionStore.size()).toBe(0)

    // Emit an invalidation after detach — no frames should land on the client.
    const countBefore = h.received.length
    h.publishInvalidation(new Set(['todos']))
    await flush()
    expect(h.received.length).toBe(countBefore)
  })

  test('re-subscribe with durable rejection clears the prior active entry', async () => {
    const h = await reactiveHarness()
    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'subscribed'), 'subscribed')
    expect(h.subscriptionStore.size()).toBe(1)

    h.send({ type: 'subscribe', id: 's1', path: 'nonExistent', args: {} })
    await until(() => h.received.some((m) => m.type === 'error'), 'replacement error')

    expect(h.received[h.received.length - 1]).toEqual({
      type: 'error',
      kind: 'subscription',
      id: 's1',
      retryable: false,
      error: 'Unknown query: nonExistent',
    })
    expect(h.subscriptionStore.size()).toBe(0)
  })

  test('superseded older subscribe error cannot disable a newer successful replacement', async () => {
    let rejectOlderQuery!: (err: Error) => void
    const olderQuery = new Promise<never>((_, reject) => {
      rejectOlderQuery = reject
    })

    const h = await reactiveHarness(undefined, (app) => {
      app.functions.set(
        'delayedBoom',
        wy.procedure.input({}).query(async () => olderQuery),
      )
    })

    h.send({ type: 'subscribe', id: 's1', path: 'delayedBoom', args: {} })
    await new Promise((r) => setTimeout(r, 5))

    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await until(() => h.received.some((m) => m.type === 'subscribed'), 'replacement subscribed')
    expect(h.subscriptionStore.size()).toBe(1)

    rejectOlderQuery(new Error('older query failed late'))
    await flush()

    expect(h.received.filter((m) => m.type === 'error')).toHaveLength(0)
    expect(h.subscriptionStore.size()).toBe(1)
  })

  test('in-flight subscribe cancelled by unsubscribe: no orphan entry in store', async () => {
    // Simulate an unsubscribe arriving during the per-subscription context-resolve await.
    // Auth resolves immediately; the subscribe-time resolve is blocked until we control it.
    let callCount = 0
    let resolveSubscribeContext!: () => void
    const subscribeContextPending = new Promise<void>((r) => {
      resolveSubscribeContext = r
    })

    const h = await reactiveHarness({
      resolveContext: async () => {
        callCount++
        if (callCount > 1) {
          // Second call is from subscribe — block here.
          await subscribeContextPending
        }
        return {}
      },
    })

    // Auth first (first resolveContext call — resolves immediately).
    h.send({ type: 'auth', token: 'tok' })
    await until(() => h.received.some((m) => m.type === 'authenticated'), 'authenticated')

    // Subscribe — this triggers a second resolveContext that blocks.
    h.send({ type: 'subscribe', id: 'cancel-me', path: 'listTodos', args: {} })
    // Wait a tick so the subscribe handler enters the awaiting state.
    await new Promise((r) => setTimeout(r, 5))

    // Unsubscribe while context is blocked in resolveContext.
    h.send({ type: 'unsubscribe', id: 'cancel-me' })
    await flush()

    // Unblock the pending context resolve — the subscribe handler should see
    // the id no longer has a current attempt and bail before registering in the store.
    resolveSubscribeContext()
    await flush()

    // No subscribed ack, no orphan entry.
    expect(h.received.filter((m) => m.type === 'subscribed')).toHaveLength(0)
    expect(h.subscriptionStore.size()).toBe(0)
  })

  test('two connections on shared store: mutation delivers exactly one invalidate per connection', async () => {
    const app = await makeApp()
    const { subscriptionStore, publishInvalidation } = makeReactiveShared(app)

    // Create two separate loopback connections against the shared store.
    function makeConn() {
      const [clientPipe, serverPipe] = createLoopbackPair<ServerMessage, ClientMessage>()
      const received: ServerMessage[] = []
      clientPipe.onMessage((m) => received.push(m))
      attachEngine(serverPipe, { app, subscriptionStore })
      return { received, send: (msg: ClientMessage) => clientPipe.send(msg) }
    }

    const connA = makeConn()
    const connB = makeConn()

    // Subscribe both with distinct sub IDs to avoid store-key collision.
    connA.send({ type: 'subscribe', id: 'sub-a', path: 'listTodos', args: {} })
    connB.send({ type: 'subscribe', id: 'sub-b', path: 'listTodos', args: {} })

    await until(
      () =>
        connA.received.some((m) => m.type === 'subscribed') &&
        connB.received.some((m) => m.type === 'subscribed'),
      'both subscribed',
    )
    expect(subscriptionStore.size()).toBe(2)

    // Emit an invalidation (simulating a mutation).
    publishInvalidation(new Set(['todos']))

    await until(
      () =>
        connA.received.some((m) => m.type === 'invalidate') &&
        connB.received.some((m) => m.type === 'invalidate'),
      'both invalidated',
    )

    // Each connection must receive exactly ONE invalidate frame — not two (no double-fan).
    const aInvalidates = connA.received.filter((m) => m.type === 'invalidate')
    const bInvalidates = connB.received.filter((m) => m.type === 'invalidate')
    expect(aInvalidates).toHaveLength(1)
    expect(bInvalidates).toHaveLength(1)
    expect(aInvalidates[0] && 'id' in aInvalidates[0] && aInvalidates[0].id).toBe('sub-a')
    expect(bInvalidates[0] && 'id' in bInvalidates[0] && bInvalidates[0].id).toBe('sub-b')
  })

  test('capability gate: subscribe without reactive ports → REACTIVITY_NOT_ENABLED', async () => {
    // Verify that the pre-existing AC #3 behaviour is unchanged when ports are absent.
    const h = await harness() // no subscriptionStore / publishInvalidation
    h.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await flush()

    expect(h.received).toEqual([
      {
        type: 'error',
        kind: 'subscription',
        id: 's1',
        retryable: false,
        error: REACTIVITY_NOT_ENABLED,
      },
    ])
  })

  test('capability gate: unsubscribe without reactive ports → tolerated silently', async () => {
    const h = await harness()
    h.send({ type: 'unsubscribe', id: 's1' })
    await flush()

    expect(h.received).toEqual([])
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

  test('engine-initiated close (timeout) unsubscribes the inbound handler', async () => {
    // Regression: closeWith used to skip unsubscribe (only detach called it),
    // leaking the onMessage handler on timeout/auth-failed/ack-failure paths.
    const app = await makeApp()
    let liveHandlers = 0
    let pipeClosed = false
    const trackingPipe = {
      id: 'tracking',
      send: () => {},
      onMessage: (_h: (m: unknown) => void) => {
        liveHandlers += 1
        return () => {
          liveHandlers -= 1
        }
      },
      close: () => {
        pipeClosed = true
      },
    }
    attachEngine(trackingPipe, {
      app,
      resolveContext: async () => ({}), // requires auth → arms the handshake timer
      authTimeoutMs: 10,
    })
    expect(liveHandlers).toBe(1)
    await new Promise((r) => setTimeout(r, 30)) // trip the timeout → closeWith('transient')
    expect(liveHandlers).toBe(0) // handler was unsubscribed by the close path
    expect(pipeClosed).toBe(true)
  })
})
