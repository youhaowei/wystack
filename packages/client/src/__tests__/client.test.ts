/**
 * client.test.ts — non-2xx error body handling for query()/mutate().
 *
 * Verification mode: real HTTP server (Bun.serve), real fetch, real createClient.
 *
 * Coverage:
 *   - A real @wystack/server handler throws `Error(X)` → the client rejection's
 *     `.message` is exactly X (not the generic `HTTP 500`). Server always
 *     responds `{ error: string }` per routes.ts, so this is the primary case.
 *   - A non-2xx response with a plain-text (non-JSON) body → the rejection
 *     message is the raw text.
 *   - A non-2xx response with an empty body → the rejection falls back to
 *     `HTTP ${status}`.
 *   - The HTTP status is preserved as a `status` property on the thrown Error.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { createRoutes, defineApp } from '@wystack/server'
import { createClient } from '../client'
import type { QueryRef, MutationRef, ActionRef } from '../refs'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

function queryRef<TArgs, TReturn>(path: string): QueryRef<TArgs, TReturn> {
  return { _path: path } as unknown as QueryRef<TArgs, TReturn>
}

function mutationRef<TArgs, TReturn>(path: string): MutationRef<TArgs, TReturn> {
  return { _path: path } as unknown as MutationRef<TArgs, TReturn>
}

function actionRef<TArgs, TReturn>(path: string): ActionRef<TArgs, TReturn> {
  return { _path: path } as unknown as ActionRef<TArgs, TReturn>
}

describe('createClient — non-2xx error body handling', () => {
  let server: ReturnType<typeof Bun.serve>
  let baseUrl: string
  let pg: PGlite

  beforeEach(async () => {
    pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(`CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, name TEXT NOT NULL)`)

    const app = await wy.build({
      db,
      functions: {
        alwaysFails: wy.procedure.input({}).query(async () => {
          throw new Error('The draft changed since review — refresh and try again.')
        }),
        alwaysFailsMutation: wy.procedure.input({}).mutation(async () => {
          throw new Error('The draft changed since review — refresh and try again.')
        }),
        alwaysFailsAction: wy.procedure.input({}).action(async () => {
          throw new Error('The external service failed.')
        }),
      },
    })

    const hono = new Hono()
    hono.route('/', createRoutes({ app, prefix: '/api' }, upgradeWebSocket))

    server = Bun.serve({ fetch: hono.fetch, websocket, port: 0 })
    baseUrl = `http://localhost:${server.port}`
  })

  afterEach(async () => {
    server.stop(true)
    await pg.close()
  })

  test('query(): server-thrown message survives the RPC boundary', async () => {
    const client = createClient({ url: baseUrl })
    const ref = queryRef<Record<string, never>, unknown>('alwaysFails')

    await expect(client.query(ref)).rejects.toThrow(
      'The draft changed since review — refresh and try again.',
    )
  })

  test('mutate(): server-thrown message survives the RPC boundary', async () => {
    const client = createClient({ url: baseUrl })
    const ref = mutationRef<Record<string, never>, unknown>('alwaysFailsMutation')

    await expect(client.mutate(ref)).rejects.toThrow(
      'The draft changed since review — refresh and try again.',
    )
  })

  test('action(): server-thrown message survives the RPC boundary', async () => {
    const client = createClient({ url: baseUrl })
    await expect(
      client.action(actionRef<Record<string, never>, unknown>('alwaysFailsAction')),
    ).rejects.toThrow('The external service failed.')
  })

  test('query(): 500 error status is preserved as a `status` property', async () => {
    const client = createClient({ url: baseUrl })
    const ref = queryRef<Record<string, never>, unknown>('alwaysFails')

    try {
      await client.query(ref)
      throw new Error('expected client.query to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(Error)
      expect((err as Error & { status?: number }).status).toBe(500)
    }
  })

  test('query(): unknown function still rejects with the server message (404)', async () => {
    const client = createClient({ url: baseUrl })
    const ref = queryRef<Record<string, never>, unknown>('doesNotExist')

    await expect(client.query(ref)).rejects.toThrow('Unknown function: doesNotExist')
  })
})

describe('createClient — non-JSON and empty error bodies', () => {
  let server: ReturnType<typeof Bun.serve>
  let baseUrl: string

  afterEach(() => {
    server?.stop(true)
  })

  test('query(): plain-text (non-JSON) error body falls back to the raw text', async () => {
    server = Bun.serve({
      fetch: () => new Response('upstream proxy exploded', { status: 502 }),
      port: 0,
    })
    baseUrl = `http://localhost:${server.port}`

    const client = createClient({ url: baseUrl })
    const ref = queryRef<Record<string, never>, unknown>('anything')

    await expect(client.query(ref)).rejects.toThrow('upstream proxy exploded')
  })

  test('mutate(): plain-text (non-JSON) error body falls back to the raw text', async () => {
    server = Bun.serve({
      fetch: () => new Response('upstream proxy exploded', { status: 502 }),
      port: 0,
    })
    baseUrl = `http://localhost:${server.port}`

    const client = createClient({ url: baseUrl })
    const ref = mutationRef<Record<string, never>, unknown>('anything')

    await expect(client.mutate(ref)).rejects.toThrow('upstream proxy exploded')
  })

  test('query(): empty error body falls back to `HTTP ${status}`', async () => {
    server = Bun.serve({
      fetch: () => new Response(null, { status: 503 }),
      port: 0,
    })
    baseUrl = `http://localhost:${server.port}`

    const client = createClient({ url: baseUrl })
    const ref = queryRef<Record<string, never>, unknown>('anything')

    await expect(client.query(ref)).rejects.toThrow('HTTP 503')
  })

  test('mutate(): empty error body falls back to `HTTP ${status}`', async () => {
    server = Bun.serve({
      fetch: () => new Response(null, { status: 503 }),
      port: 0,
    })
    baseUrl = `http://localhost:${server.port}`

    const client = createClient({ url: baseUrl })
    const ref = mutationRef<Record<string, never>, unknown>('anything')

    await expect(client.mutate(ref)).rejects.toThrow('HTTP 503')
  })
})

describe('createClient — Action cancellation', () => {
  let server: ReturnType<typeof Bun.serve>

  afterEach(() => server?.stop(true))

  test('aborting an in-flight HTTP Action rejects the client request', async () => {
    server = Bun.serve({
      fetch: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        return Response.json({ data: 'late' })
      },
      port: 0,
    })
    const client = createClient({ url: `http://localhost:${server.port}` })
    const controller = new AbortController()
    const pending = client.action(
      actionRef<Record<string, never>, string>('slow'),
      {},
      {
        signal: controller.signal,
      },
    )
    controller.abort()

    await expect(pending).rejects.toThrow()
  })
})

describe('createClient — app-provided context', () => {
  test('sends a fresh reserved context envelope without spoofable identity headers', async () => {
    const contexts: unknown[] = []
    const auth: Array<string | null> = []
    const proxyUsers: Array<string | null> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (_input: URL | RequestInfo, init?: RequestInit) => {
        const headers = new Headers(init?.headers)
        const context = headers.get('x-wystack-context')
        contexts.push(context === null ? null : JSON.parse(decodeURIComponent(context)))
        auth.push(headers.get('authorization'))
        proxyUsers.push(headers.get('x-auth-request-user'))
        return Response.json({ data: null })
      },
      { preconnect: realFetch.preconnect },
    )
    let contextCalls = 0
    const client = createClient({
      url: 'https://api.example',
      getToken: () => 'real-token',
      getContext: () => ({ tenantId: `tenant-${++contextCalls}`, label: '你好 👋' }),
    })

    try {
      await client.query(queryRef('query'))
      await client.mutate(mutationRef('mutation'))
      await client.action(actionRef('action'))
    } finally {
      globalThis.fetch = realFetch
    }

    expect(contexts).toEqual([
      { tenantId: 'tenant-1', label: '你好 👋' },
      { tenantId: 'tenant-2', label: '你好 👋' },
      { tenantId: 'tenant-3', label: '你好 👋' },
    ])
    expect(auth).toEqual(['Bearer real-token', 'Bearer real-token', 'Bearer real-token'])
    expect(proxyUsers).toEqual([null, null, null])
  })
})
