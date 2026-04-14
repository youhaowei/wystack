import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack } from '../create'
import { query, mutation } from '../functions'
import { serve } from '../serve-bun'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
})

// Per-test app factory for auth scenarios: each test creates its own
// PGlite + createWyStack + serve so resolveContext can vary freely.
// Default functions cover the common cases (listTodos + whoami); override
// via `functions` when a test needs something specific.
type AuthTestFunctions = NonNullable<Parameters<typeof createWyStack>[0]['functions']>
async function makeAuthApp(functions?: AuthTestFunctions) {
  const pg = new PGlite()
  const db = drizzle(pg)
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  const defaults = {
    listTodos: query({ args: {}, handler: async (_ctx) => [] }),
    whoami: query({ args: {}, handler: async (ctx) => ({ userId: ctx.userId as string }) }),
    addTodo: mutation({
      args: { title: text },
      handler: async (ctx, args) =>
        ctx.db.into(schema.todos).insert({ title: args.title, done: false }),
    }),
  }
  return createWyStack({ db, functions: functions ?? defaults })
}

let server: ReturnType<typeof serve>
let baseUrl: string

beforeEach(async () => {
  const pg = new PGlite()
  const db = drizzle(pg)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS todos (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN NOT NULL
    )
  `)

  const app = await createWyStack({
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
  baseUrl = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

describe('HTTP transport', () => {
  test('GET /api/listTodos returns empty array', async () => {
    const res = await fetch(`${baseUrl}/api/listTodos`)
    const json = await res.json()
    expect(json.data).toEqual([])
  })

  test('POST /api/addTodo creates a todo', async () => {
    const res = await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test todo' }),
    })
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].title).toBe('Test todo')
  })

  test('POST /api/unknown returns 404', async () => {
    const res = await fetch(`${baseUrl}/api/unknown`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  test('GET / returns 404', async () => {
    const res = await fetch(baseUrl)
    expect(res.status).toBe(404)
  })

  test('GET query with args', async () => {
    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Hello' }),
    })

    const res = await fetch(`${baseUrl}/api/listTodos`)
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].title).toBe('Hello')
  })

  test('resolveContext is called per request', async () => {
    const pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(
      `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
    )

    const app = await createWyStack({
      db,
      functions: {
        whoami: query({
          args: {},
          handler: async (ctx) => ({ userId: ctx.userId }),
        }),
      },
    })

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
      // Without token → 401
      const noAuth = await fetch(`http://localhost:${authServer.port}/api/whoami`)
      expect(noAuth.status).toBe(401)

      // With token → context passed through
      const withAuth = await fetch(`http://localhost:${authServer.port}/api/whoami`, {
        headers: { Authorization: 'Bearer user_123' },
      })
      const json = await withAuth.json()
      expect(json.data.userId).toBe('user_123')
    } finally {
      authServer.stop(true)
    }
  })
})

describe('WebSocket transport', () => {
  test('subscribe returns confirmation', async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`)

    // oxlint-disable-next-line typescript/no-explicit-any -- WS message payload is dynamically typed JSON
    const result = await new Promise<any>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'listTodos', args: {} }))
      }
      ws.onmessage = (event) => {
        resolve(JSON.parse(event.data))
        ws.close()
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    expect(result.type).toBe('subscribed')
    expect(result.id).toBe('sub1')
  })

  test('mutation sends invalidation signal to subscriber', async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`)

    // Subscribe first
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'listTodos', args: {} }))
      }
      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)
        if (msg.type === 'subscribed') resolve()
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    // Mutate via HTTP
    // oxlint-disable-next-line typescript/no-explicit-any -- WS message payload is dynamically typed JSON
    const invalidation = new Promise<any>((resolve, reject) => {
      ws.onmessage = (event) => resolve(JSON.parse(event.data))
      setTimeout(() => reject(new Error('timeout waiting for invalidation')), 5000)
    })

    await fetch(`${baseUrl}/api/addTodo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'triggers invalidation' }),
    })

    const msg = await invalidation
    expect(msg.type).toBe('invalidate')
    expect(msg.id).toBe('sub1')

    ws.close()
  })

  test('subscribe to unknown query returns error', async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`)

    // oxlint-disable-next-line typescript/no-explicit-any -- WS message payload is dynamically typed JSON
    const result = await new Promise<any>((resolve, reject) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'nonexistent', args: {} }))
      }
      ws.onmessage = (event) => {
        resolve(JSON.parse(event.data))
        ws.close()
      }
      ws.onerror = reject
      setTimeout(() => reject(new Error('timeout')), 5000)
    })

    expect(result.type).toBe('error')
  })

  test('WS subscribe before auth handshake closes with 4001', async () => {
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
      const ws = new WebSocket(`ws://localhost:${authServer.port}/api/ws`)
      const closeCode = await new Promise<number>((resolve, reject) => {
        ws.onopen = () => {
          // Violate protocol: send subscribe before auth
          ws.send(JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'listTodos', args: {} }))
        }
        ws.onclose = (event) => resolve(event.code)
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('timeout')), 5000)
      })
      expect(closeCode).toBe(4001)
    } finally {
      authServer.stop(true)
    }
  })

  test('WS auth handshake succeeds and subscribe works', async () => {
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
      const ws = new WebSocket(`ws://localhost:${authServer.port}/api/ws`)
      // oxlint-disable-next-line typescript/no-explicit-any -- dynamic JSON
      const messages: any[] = []
      const done = new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth', v: '0.1.0', token: 'user_123' }))
        }
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          messages.push(msg)
          if (msg.type === 'authenticated') {
            ws.send(JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'whoami', args: {} }))
          }
          if (msg.type === 'subscribed') resolve()
        }
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('timeout')), 5000)
      })
      await done
      ws.close()
      const authenticated = messages.find((m) => m.type === 'authenticated')
      const subscribed = messages.find((m) => m.type === 'subscribed')
      expect(authenticated).toBeDefined()
      expect(subscribed).toBeDefined()
      expect(subscribed.id).toBe('sub1')
    } finally {
      authServer.stop(true)
    }
  })

  test('WS auth with invalid token closes 4001', async () => {
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
      const ws = new WebSocket(`ws://localhost:${authServer.port}/api/ws`)
      const closeCode = await new Promise<number>((resolve, reject) => {
        ws.onopen = () => {
          // Auth message with no token → resolveContext throws
          ws.send(JSON.stringify({ type: 'auth', v: '0.1.0', token: null }))
        }
        ws.onclose = (event) => resolve(event.code)
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('timeout')), 5000)
      })
      expect(closeCode).toBe(4001)
    } finally {
      authServer.stop(true)
    }
  })

  test('resolveContext runs per subscription (AC #7: subscription-time context)', async () => {
    const app = await makeAuthApp()
    let resolveCount = 0
    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (req) => {
        resolveCount++
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    try {
      const ws = new WebSocket(`ws://localhost:${authServer.port}/api/ws`)
      let subscribedCount = 0
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth', v: '0.1.0', token: 'user_123' }))
        }
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          if (msg.type === 'authenticated') {
            ws.send(JSON.stringify({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} }))
            ws.send(JSON.stringify({ type: 'subscribe', id: 's2', path: 'listTodos', args: {} }))
          }
          if (msg.type === 'subscribed') {
            subscribedCount++
            if (subscribedCount === 2) resolve()
          }
        }
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('timeout')), 5000)
      })
      ws.close()

      // Spec: "Context resolved at subscription time". At minimum, resolveContext
      // runs per-subscription → >= 2 calls for 2 subs. A tighter implementation
      // may also call at handshake (current impl → 3); a spec-compliant one that
      // skips the handshake call → 2. Both are acceptable.
      expect(resolveCount).toBeGreaterThanOrEqual(2)
    } finally {
      authServer.stop(true)
    }
  })

  // Protocol version compatibility matrix — server is at 0.1.0 (pre-1.0).
  // Pre-1.0 rule: only patch and prerelease differences are compatible.
  const protocolVersionCases: Array<{ v: string; accept: boolean; why: string }> = [
    { v: '0.1.0', accept: true, why: 'exact match' },
    { v: '0.1.5', accept: true, why: 'patch diff — compatible' },
    { v: '0.1.0-alpha', accept: true, why: 'prerelease — compatible' },
    { v: '0.2.0', accept: false, why: 'pre-1.0 minor bump — breaking' },
    { v: '99.0.0', accept: false, why: 'major diff — breaking' },
    { v: 'not-a-version', accept: false, why: 'invalid semver' },
  ]

  for (const { v, accept, why } of protocolVersionCases) {
    test(`WS protocol version ${v} ${accept ? 'accepted' : 'rejected'} (${why})`, async () => {
      const app = await makeAuthApp()
      const authServer = serve({
        app,
        port: 0,
        resolveContext: async (_req) => ({ userId: 'anyone' }),
      })

      try {
        const ws = new WebSocket(`ws://localhost:${authServer.port}/api/ws`)
        const outcome = await new Promise<'authenticated' | number>((resolve, reject) => {
          ws.onopen = () => {
            ws.send(JSON.stringify({ type: 'auth', v, token: 'valid' }))
          }
          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data)
            if (msg.type === 'authenticated') resolve('authenticated')
          }
          ws.onclose = (event) => resolve(event.code)
          ws.onerror = () => reject(new Error('ws error'))
          setTimeout(() => reject(new Error('timeout')), 5000)
        })
        ws.close()
        if (accept) {
          expect(outcome).toBe('authenticated')
        } else {
          expect(outcome).toBe(4001)
        }
      } finally {
        authServer.stop(true)
      }
    })
  }

  // NOTE: a test for the "hung resolveContext → close 4001 via Promise.race"
  // path was attempted but removed because bun:test waits for pending promises
  // to settle at process exit. A long-but-finite resolveContext keeps the
  // event loop alive beyond the test's assertion. Covered by the Promise.race
  // in routes.ts (see auth handshake block) and tracked for the vitest
  // migration ticket, where fake timers make this testable without real waits.

  test('WS anonymous auth succeeds (null token + accepting resolveContext)', async () => {
    // Real production case: public server that accepts unauthenticated users
    // as anonymous. resolveContext does NOT throw on missing Authorization.
    const app = await makeAuthApp()
    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '') ?? null
        return { userId: token ?? 'anon' }
      },
    })

    try {
      const ws = new WebSocket(`ws://localhost:${authServer.port}/api/ws`)
      const outcome = await new Promise<'authenticated' | number>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth', v: '0.1.0', token: null }))
        }
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          if (msg.type === 'authenticated') resolve('authenticated')
        }
        ws.onclose = (event) => resolve(event.code)
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('timeout')), 5000)
      })
      ws.close()
      expect(outcome).toBe('authenticated')
    } finally {
      authServer.stop(true)
    }
  })

  test('WS missing `v` field closes 4001', async () => {
    // Strict reject — missing `v` is a one-way door. Tolerating it would
    // create legacy "no-v" clients forever. Distinct code path from invalid-
    // semver `v` (which the matrix already covers).
    const app = await makeAuthApp()
    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (_req) => ({ userId: 'anyone' }),
    })

    try {
      const ws = new WebSocket(`ws://localhost:${authServer.port}/api/ws`)
      const closeCode = await new Promise<number>((resolve, reject) => {
        ws.onopen = () => {
          // No `v` field at all
          ws.send(JSON.stringify({ type: 'auth', token: 'valid' }))
        }
        ws.onclose = (event) => resolve(event.code)
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('timeout')), 5000)
      })
      expect(closeCode).toBe(4001)
    } finally {
      authServer.stop(true)
    }
  })

  test('WS idempotent auth ACK on no-auth server (token-configured client)', async () => {
    // No-auth server + token-configured client: client sends `auth` frame,
    // server must ACK so the client's authAckTimer doesn't fire and force a
    // 4002 reconnect loop. The server does not run resolveContext in this
    // path — the ACK is structural.
    const app = await makeAuthApp()
    const noAuthServer = serve({ app, port: 0 }) // no resolveContext

    try {
      const ws = new WebSocket(`ws://localhost:${noAuthServer.port}/api/ws`)
      const outcome = await new Promise<'authenticated' | number>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth', v: '0.1.0', token: 'anything' }))
        }
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          if (msg.type === 'authenticated') resolve('authenticated')
        }
        ws.onclose = (event) => resolve(event.code)
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('timeout')), 5000)
      })
      ws.close()
      expect(outcome).toBe('authenticated')
    } finally {
      noAuthServer.stop(true)
    }
  })

  test('WS idempotent ACK path still validates `v` (no-auth server, incompatible client)', async () => {
    // The version gate must apply on the no-auth server's ACK path too —
    // otherwise wire-incompatible clients silently connect and subscribe.
    const app = await makeAuthApp()
    const noAuthServer = serve({ app, port: 0 })

    try {
      const ws = new WebSocket(`ws://localhost:${noAuthServer.port}/api/ws`)
      const closeCode = await new Promise<number>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth', v: '99.0.0', token: null }))
        }
        ws.onclose = (event) => resolve(event.code)
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('timeout')), 5000)
      })
      expect(closeCode).toBe(4001)
    } finally {
      noAuthServer.stop(true)
    }
  })

  test('WS invalidation re-queries with the subscription-time context (not a fresh resolve)', async () => {
    // Spec decision: "Context resolved at subscription time, preserved for
    // re-queries." The invalidation re-run must reuse sub.context, not call
    // resolveContext again. We observe this by (1) counting handler calls
    // per userId and (2) asserting resolveContext isn't invoked by the re-run.
    let resolveCount = 0
    let resolveCaller = 0
    const handlerCalls: Array<{ userId: string }> = []

    const app = await makeAuthApp({
      whoami: query({
        args: {},
        handler: async (ctx) => {
          handlerCalls.push({ userId: ctx.userId as string })
          return { userId: ctx.userId as string, todos: ctx.db.from(schema.todos).all() }
        },
      }),
      addTodo: mutation({
        args: { title: text },
        handler: async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ title: args.title, done: false }),
      }),
    })
    const authServer = serve({
      app,
      port: 0,
      resolveContext: async (_req) => {
        resolveCount++
        resolveCaller++
        return { userId: `caller${resolveCaller}` }
      },
    })

    try {
      // 1. Open WS, auth, subscribe — resolveContext called once (for sub).
      const ws = new WebSocket(`ws://localhost:${authServer.port}/api/ws`)
      const subId = 'sub-ctx-preserve'
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'auth', v: '0.1.0', token: 'tok' }))
        }
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          if (msg.type === 'authenticated') {
            ws.send(JSON.stringify({ type: 'subscribe', id: subId, path: 'whoami', args: {} }))
          } else if (msg.type === 'subscribed' && msg.id === subId) {
            resolve()
          }
        }
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('subscribe timeout')), 5000)
      })

      // resolveContext runs for auth handshake (call 1) AND for subscribe
      // (call 2) — per-spec. The subscription's preserved context is the
      // second one (caller2), which is what the handler saw.
      const subCaller = handlerCalls[0]?.userId
      expect(handlerCalls).toHaveLength(1)
      expect(subCaller).toMatch(/^caller\d+$/)
      const beforeMutation = resolveCount

      // 2. Mutate over HTTP → triggers invalidation re-run. The mutation's
      //    own resolveContext increments the counter; the re-run MUST NOT.
      const invalidated = new Promise<void>((resolve) => {
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          if (msg.type === 'invalidate' && msg.id === subId) resolve()
        }
      })
      await fetch(`http://localhost:${authServer.port}/api/addTodo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
        body: JSON.stringify({ title: 'test' }),
      })
      await invalidated
      ws.close()

      // Handler must have re-run with the PRESERVED subscribe-time userId,
      // not a fresh resolve. The mutation's own resolveContext increments
      // the counter once; the invalidation re-run must not.
      expect(handlerCalls.length).toBeGreaterThanOrEqual(2)
      expect(handlerCalls.every((c) => c.userId === subCaller)).toBe(true)
      // beforeMutation + 1 (mutation auth) === after. Re-run adds 0.
      expect(resolveCount).toBe(beforeMutation + 1)
    } finally {
      authServer.stop(true)
    }
  })

  test('WS auth timeout closes 4002', async () => {
    const app = await makeAuthApp()
    const authServer = serve({
      app,
      port: 0,
      authTimeoutMs: 500,
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    try {
      const ws = new WebSocket(`ws://localhost:${authServer.port}/api/ws`)
      const closeCode = await new Promise<number>((resolve, reject) => {
        ws.onopen = () => {
          // Don't send anything — wait for timeout
        }
        ws.onclose = (event) => resolve(event.code)
        ws.onerror = () => reject(new Error('ws error'))
        setTimeout(() => reject(new Error('timeout')), 5000)
      })
      expect(closeCode).toBe(4002)
    } finally {
      authServer.stop(true)
    }
  })
})
