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
import type { QueryRef, MutationRef } from '../refs'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

function queryRef<TArgs, TReturn>(path: string): QueryRef<TArgs, TReturn> {
  return { _path: path } as unknown as QueryRef<TArgs, TReturn>
}

function mutationRef<TArgs, TReturn>(path: string): MutationRef<TArgs, TReturn> {
  return { _path: path } as unknown as MutationRef<TArgs, TReturn>
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
