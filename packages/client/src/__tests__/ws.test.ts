import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createDb, defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack, query, mutation } from '@wystack/server'
import { serve } from '@wystack/server/bun'
import { createClient } from '../client'
import { createWsManager } from '../ws'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
})

// Per-test app factory for auth scenarios — each test creates its own
// PGlite + createWyStack so resolveContext can vary freely.
async function makeAuthApp() {
  const db = await createDb({ dev: 'pglite://' })
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  return createWyStack({
    db,
    functions: {
      listTodos: query({
        args: {},
        handler: async (ctx) => ctx.db.from(schema.todos).all(),
      }),
      addTodo: mutation({
        args: { title: text },
        handler: async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ title: args.title, done: false }),
      }),
    },
  })
}

let server: ReturnType<typeof serve>
let wsUrl: string
let baseUrl: string
let app: Awaited<ReturnType<typeof createWyStack>>

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
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

async function waitForConnected(ws: ReturnType<typeof createWsManager>): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (ws.isConnected()) {
          clearInterval(check)
          resolve()
        }
      }, 10)
    }),
    'connect',
  )
}

async function waitUntil(predicate: () => boolean, label: string): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (predicate()) {
          clearInterval(check)
          resolve()
        }
      }, 10)
    }),
    label,
  )
}

async function mutateTodo(
  url: string,
  title: string,
  headers: Record<string, string> = {},
): Promise<void> {
  await fetch(`${url}/api/addTodo`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ title }),
  })
}

// Test pragma: `subscribe()` returns synchronously while the `subscribed` ack
// is still in flight, so a single mutation can race the registration. We loop
// mutations until invalidate fires. Assumes the server collapses repeated
// invalidations into one per sub — if that ever changes, this loop will need
// reshaping. Durable fix is exposing `subscribe(): Promise<void>` resolving on
// the ack; tracked separately.
async function mutateUntilInvalidated(
  url: string,
  title: string,
  invalidated: Promise<void>,
  headers?: Record<string, string>,
): Promise<void> {
  let done = false
  invalidated.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )

  for (let attempt = 0; !done; attempt++) {
    await mutateTodo(url, `${title} ${attempt}`, headers)
    let pause: ReturnType<typeof setTimeout> | null = null
    await Promise.race([
      invalidated,
      new Promise<void>((resolve) => {
        pause = setTimeout(resolve, 25)
      }),
    ])
    if (pause !== null) clearTimeout(pause)
  }
}

async function openProbeSubscription(
  url: string,
  id: string,
): Promise<{
  ws: WebSocket
  nextInvalidation: () => Promise<void>
}> {
  const probe = new WebSocket(url)

  let resolveNextInvalidation: (() => void) | null = null
  const nextInvalidation = () =>
    withTimeout(
      new Promise<void>((resolve) => {
        resolveNextInvalidation = resolve
      }),
      'probe invalidation',
    )

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      probe.onopen = () => {
        probe.send(JSON.stringify({ type: 'subscribe', id, path: 'listTodos', args: {} }))
      }
      probe.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'subscribed' && msg.id === id) resolve()
        if (msg.type === 'invalidate' && msg.id === id) {
          resolveNextInvalidation?.()
          resolveNextInvalidation = null
        }
      }
      probe.onerror = () => reject(new Error('probe ws error'))
    }),
    'probe subscribe',
  )

  return { ws: probe, nextInvalidation }
}

beforeEach(async () => {
  const db = await createDb({ dev: 'pglite://' })
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL
    )
  `)

  app = await createWyStack({
    db,
    functions: {
      listTodos: query({
        args: {},
        handler: async (ctx) => ctx.db.from(schema.todos).all(),
      }),
      addTodo: mutation({
        args: { title: text },
        handler: async (ctx, args) => {
          return ctx.db.into(schema.todos).insert({ title: args.title, done: false })
        },
      }),
    },
  })

  server = serve({ app, port: 0 })
  wsUrl = `ws://localhost:${server.port}/api/ws`
  baseUrl = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

describe('WsManager', () => {
  test('connects and reports connected', async () => {
    const ws = createWsManager({ url: wsUrl })
    ws.connect()

    await waitForConnected(ws)

    expect(ws.isConnected()).toBe(true)
    ws.disconnect()
    expect(ws.isConnected()).toBe(false)
  })

  test('receives invalidation after mutation', async () => {
    const subscribed = deferred<void>()
    const ws = createWsManager({
      url: wsUrl,
      onSubscribed: (id) => {
        if (id === 'sub1') subscribed.resolve()
      },
    })
    ws.connect()

    await waitForConnected(ws)

    // Subscribe — handler fires on invalidation only
    const invalidated = withTimeout(
      new Promise<void>((resolve) => {
        ws.subscribe('sub1', 'listTodos', {}, () => resolve())
      }),
      'invalidation',
    )

    await mutateUntilInvalidated(baseUrl, 'From WS test', invalidated)
    await invalidated
    ws.disconnect()
  })

  test('unsubscribe stops receiving invalidations', async () => {
    const subscribed = deferred<void>()
    const ws = createWsManager({
      url: wsUrl,
      onSubscribed: (id) => {
        if (id === 'sub1') subscribed.resolve()
      },
    })
    ws.connect()

    await waitForConnected(ws)

    let invalidateCount = 0
    const firstInvalidation = deferred<void>()
    ws.subscribe('sub1', 'listTodos', {}, () => {
      invalidateCount++
      firstInvalidation.resolve()
    })
    await withTimeout(subscribed.promise, 'timeout waiting for subscription')

    // First mutation — should trigger invalidation
    const firstInvalidationRace = withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (invalidateCount === 1) {
            clearInterval(check)
            resolve()
          }
        }, 10)
      }),
      'first invalidation',
    )
    await mutateUntilInvalidated(baseUrl, 'First', firstInvalidationRace)
    await firstInvalidationRace
    expect(invalidateCount).toBe(1)

    const probe = await openProbeSubscription(wsUrl, 'probe-after-unsubscribe')

    ws.unsubscribe('sub1')
    await waitUntil(() => !app.subscriptions.get('sub1'), 'unsubscribe processed')

    // Second mutation — should NOT trigger
    const probeInvalidated = probe.nextInvalidation()
    await mutateTodo(baseUrl, 'Second')
    await probeInvalidated
    expect(invalidateCount).toBe(1)

    probe.ws.close()
    ws.disconnect()
  })

  test('sends auth handshake and buffers subscribes until authenticated', async () => {
    // Separate server requiring auth
    const app = await makeAuthApp()

    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    try {
      const subscribed = deferred<void>()
      const ws = createWsManager({
        url: `ws://localhost:${authServer.port}/api/ws`,
        getToken: () => 'user_123',
        onSubscribed: (id) => {
          if (id === 'sub1') subscribed.resolve()
        },
      })
      ws.connect()

      // Count per-handler calls so we can assert exactly-one-fires, not just
      // that *something* resolved the promise. Catches mechanism-change
      // regressions where the handler could fire for the wrong sub or twice.
      let sub1Invalidations = 0
      const invalidated = withTimeout(
        new Promise<void>((resolve) => {
          // Call subscribe immediately — before WS even opens. Must not lose the sub.
          ws.subscribe('sub1', 'listTodos', {}, () => {
            sub1Invalidations++
            resolve()
          })
        }),
        'authenticated invalidation',
      )

      // Trigger invalidation via HTTP mutation
      await mutateUntilInvalidated(`http://localhost:${authServer.port}`, 'Authed', invalidated, {
        Authorization: 'Bearer user_123',
      })

      await invalidated

      // Prove the buffered-subscribe-then-flush actually happened end-to-end:
      expect(sub1Invalidations).toBe(1)
      expect(ws.isConnected()).toBe(true)

      ws.disconnect()
    } finally {
      authServer.stop(true)
    }
  })

  test('requiresAuth:true without getToken sends null-token auth frame (cookie/session auth)', async () => {
    // Simulates a server that uses resolveContext for cookie/proxy-header auth —
    // no JWT, but the client still needs to trigger the handshake so the server
    // can run resolveContext against the upgrade request headers.
    const app = await makeAuthApp()

    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (_req) => {
        // In real usage this would read cookies; here we just accept anonymously
        // to prove the auth frame was sent and the handshake completed.
        return { userId: 'cookie-user' }
      },
    })

    try {
      const subscribed = deferred<void>()
      const ws = createWsManager({
        url: `ws://localhost:${authServer.port}/api/ws`,
        requiresAuth: true, // no getToken — cookie auth pattern
        onSubscribed: (id) => {
          if (id === 'sub1') subscribed.resolve()
        },
      })
      ws.connect()

      const invalidated = withTimeout(
        new Promise<void>((resolve) => {
          ws.subscribe('sub1', 'listTodos', {}, () => resolve())
        }),
        'cookie auth invalidation',
      )

      await mutateUntilInvalidated(
        `http://localhost:${authServer.port}`,
        'Cookie authed',
        invalidated,
      )

      await invalidated
      expect(ws.isConnected()).toBe(true)
      ws.disconnect()
    } finally {
      authServer.stop(true)
    }
  })

  test('createClient requiresAuth:false keeps WS no-auth even with getToken configured', async () => {
    let tokenCalls = 0
    const client = createClient({
      url: baseUrl,
      requiresAuth: false,
      getToken: () => {
        tokenCalls++
        throw new Error('WS no-auth path must not call getToken')
      },
    })

    client.ws.connect()

    const invalidated = withTimeout(
      new Promise<void>((resolve) => {
        client.ws.subscribe('sub1', 'listTodos', {}, () => resolve())
      }),
      'trusted runtime invalidation',
    )

    await mutateUntilInvalidated(baseUrl, 'Trusted local runtime', invalidated)

    await invalidated
    expect(tokenCalls).toBe(0)
    expect(client.ws.isConnected()).toBe(true)
    client.ws.disconnect()
  })

  test('does not reconnect on close code 4001', async () => {
    const app = await makeAuthApp()

    // Count auth attempts on the server. Each connection attempt runs
    // resolveContext once at handshake time (per Finding #1 fix).
    // No retries ⇒ count === 1. A reconnect loop ⇒ count > 1.
    let authAttempts = 0
    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (req) => {
        authAttempts++
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    try {
      const ws = createWsManager({
        url: `ws://localhost:${authServer.port}/api/ws`,
        getToken: () => null, // triggers server close 4001
      })
      ws.connect()

      // Wait well past the first reconnect window (~1-1.5s). If the client
      // were retrying, authAttempts would tick up every cycle.
      await new Promise((r) => setTimeout(r, 2500))

      expect(ws.isConnected()).toBe(false)
      expect(authAttempts).toBe(1) // exactly one connection attempt, no retry
      ws.disconnect()
    } finally {
      authServer.stop(true)
    }
  })

  test('re-subscribes on reconnect', async () => {
    let subscribedCount = 0
    const firstSubscribed = deferred<void>()
    const secondSubscribed = deferred<void>()
    const ws = createWsManager({
      url: wsUrl,
      onSubscribed: (id) => {
        if (id !== 'sub1') return
        subscribedCount++
        if (subscribedCount === 1) firstSubscribed.resolve()
        if (subscribedCount === 2) secondSubscribed.resolve()
      },
    })
    ws.connect()

    await waitForConnected(ws)

    let invalidateCount = 0
    const firstInvalidation = deferred<void>()
    const secondInvalidation = deferred<void>()
    ws.subscribe('sub1', 'listTodos', {}, () => {
      invalidateCount++
      if (invalidateCount === 1) firstInvalidation.resolve()
      if (invalidateCount === 2) secondInvalidation.resolve()
    })
    await withTimeout(firstSubscribed.promise, 'timeout waiting for subscription')

    // Trigger invalidation before disconnect
    const firstInvalidationRace = withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (invalidateCount === 1) {
            clearInterval(check)
            resolve()
          }
        }, 10)
      }),
      'first reconnect-test invalidation',
    )
    await mutateUntilInvalidated(baseUrl, 'Before reconnect', firstInvalidationRace)
    await firstInvalidationRace
    expect(invalidateCount).toBe(1)

    // Force reconnect by disconnecting + reconnecting
    ws.disconnect()
    ws.connect()

    await waitForConnected(ws)
    await withTimeout(secondSubscribed.promise, 'timeout waiting for resubscription')

    // Trigger invalidation after reconnect
    const secondInvalidationRace = withTimeout(
      new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (invalidateCount === 2) {
            clearInterval(check)
            resolve()
          }
        }, 10)
      }),
      'second reconnect-test invalidation',
    )
    await mutateUntilInvalidated(baseUrl, 'After reconnect', secondInvalidationRace)
    await secondInvalidationRace
    expect(invalidateCount).toBe(2)

    ws.disconnect()
  })

  test('reconnects after server-side 4002 auth timeout', async () => {
    // Server hangs the FIRST resolveContext past authTimeoutMs so it closes
    // 4002, then completes normally on the retry. Proves the WyStack client
    // treats 4002 as transient and reconnects with backoff (vs. 4001 which
    // latches authFailed and stops).
    const app = await makeAuthApp()
    let resolveCount = 0
    const authServer = serve({
      app,
      port: 0,
      authTimeoutMs: 50,
      resolveContext: async (req) => {
        resolveCount++
        if (resolveCount === 1) {
          await new Promise(() => {
            // Intentionally hang forever; the server's authTimeoutMs (50ms)
            // closes the socket 4002 before this ever resolves. The hung
            // promise leaks until the server stops in finally — harmless.
          })
        }
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    try {
      const ws = createWsManager({
        url: `ws://localhost:${authServer.port}/api/ws`,
        getToken: () => 'user_123',
        authAckTimeoutMs: 500,
      })
      ws.connect()

      await withTimeout(
        new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (ws.isConnected() && resolveCount >= 2) {
              clearInterval(check)
              resolve()
            }
          }, 10)
        }),
        '4002 retry',
      )

      expect(resolveCount).toBeGreaterThanOrEqual(2)
      expect(ws.isConnected()).toBe(true)
      ws.disconnect()
    } finally {
      authServer.stop(true)
    }
  })

  test('requiresAuth:false against auth-required server closes 4001 and stops retrying', async () => {
    // Mismatched contract: client thinks WS is trusted, server requires auth.
    // First subscribe frame arrives unauthenticated → server closes 4001 →
    // client latches authFailed and never retries. Loud failure mode.
    const app = await makeAuthApp()
    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    try {
      let connectCount = 0
      // Spy on the global WebSocket constructor to count connection attempts
      // without depending on the manager's internals.
      const RealWebSocket = global.WebSocket
      class CountingWebSocket extends RealWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          connectCount++
          super(url, protocols)
        }
      }
      ;(global as { WebSocket: typeof WebSocket }).WebSocket =
        CountingWebSocket as unknown as typeof WebSocket

      try {
        const ws = createWsManager({
          url: `ws://localhost:${authServer.port}/api/ws`,
          requiresAuth: false,
        })
        ws.connect()
        ws.subscribe('sub1', 'listTodos', {}, () => {})

        // Wait long enough for the server to close 4001 and for any
        // exponential-backoff retry to have fired (would be ~1-2s).
        await new Promise((r) => setTimeout(r, 2500))

        expect(connectCount).toBe(1)
        expect(ws.isConnected()).toBe(false)
        ws.disconnect()
      } finally {
        ;(global as { WebSocket: typeof WebSocket }).WebSocket = RealWebSocket
      }
    } finally {
      authServer.stop(true)
    }
  })
})
