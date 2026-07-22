/**
 * Embedded mount test — proves createRoutes() can be mounted into
 * a consumer's existing Hono app via .route().
 *
 * This is the pattern Workforce's adoption depends on:
 *   const wyRoutes = createRoutes({ app: wyApp, prefix: '/api' }, upgradeWebSocket)
 *   consumerApp.route('/wystack', wyRoutes)
 *
 * All tests below use prefix: '/api', so routes are reachable at /wystack/api/*.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { upgradeWebSocket, websocket } from 'hono/bun'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { createRoutes } from '../routes'
import { defineApp } from '../define-app'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const schema = defineSchema({
  items: {
    id: int.primaryKey(),
    name: text,
    active: boolean,
  },
})

let server: ReturnType<typeof Bun.serve>
let baseUrl: string

beforeEach(async () => {
  const pg = new PGlite()
  const db = drizzle(pg)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      active BOOLEAN NOT NULL
    )
  `)

  const app = await wy.build({
    db,
    functions: {
      listItems: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.items).all()),
      addItem: wy.procedure.input({ name: text }).mutation(async (ctx, args) => {
        return ctx.db.into(schema.items).insert({ name: args.name, active: true })
      }),
    },
  })

  // --- Simulate consumer's existing Hono app ---
  const consumerApp = new Hono()

  // Consumer's own routes
  consumerApp.get('/health', (c) => c.json({ status: 'ok' }))

  // Mount WyStack routes under /wystack prefix
  const wyRoutes = createRoutes({ app, prefix: '/api' }, upgradeWebSocket)
  consumerApp.route('/wystack', wyRoutes)

  server = Bun.serve({
    fetch: consumerApp.fetch,
    websocket,
    port: 0,
  })
  baseUrl = `http://localhost:${server.port}`
})

afterEach(() => {
  server.stop(true)
})

describe('Embedded mount: createRoutes into existing Hono app', () => {
  test('consumer own routes still work', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const json = await res.json()
    expect(json.status).toBe('ok')
  })

  test('GET query works at mounted prefix', async () => {
    const res = await fetch(`${baseUrl}/wystack/api/listItems`)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toEqual([])
  })

  test('POST mutation works at mounted prefix', async () => {
    const res = await fetch(`${baseUrl}/wystack/api/addItem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Widget' }),
    })
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.data).toHaveLength(1)
    expect(json.data[0].name).toBe('Widget')
  })

  test('full lifecycle: query → mutate → query reflects change', async () => {
    // Empty initially
    const before = await fetch(`${baseUrl}/wystack/api/listItems`)
    const beforeJson = await before.json()
    expect(beforeJson.data).toEqual([])

    // Add item
    await fetch(`${baseUrl}/wystack/api/addItem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Gadget' }),
    })

    // Now has one item
    const after = await fetch(`${baseUrl}/wystack/api/listItems`)
    const afterJson = await after.json()
    expect(afterJson.data).toHaveLength(1)
    expect(afterJson.data[0].name).toBe('Gadget')
  })

  test('WS subscribe + invalidation at mounted prefix', async () => {
    const ws = new WebSocket(`ws://localhost:${server.port}/wystack/api/ws`)

    try {
      // Subscribe
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'subscribe', id: 'emb-sub', path: 'listItems', args: {} }))
        }
        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data)
          if (msg.type === 'subscribed') resolve()
        }
        ws.onerror = reject
        setTimeout(() => reject(new Error('timeout')), 5000)
      })

      // Mutate via HTTP and expect invalidation
      // oxlint-disable-next-line typescript/no-explicit-any -- WS message payload is dynamically typed JSON
      const invalidation = new Promise<any>((resolve, reject) => {
        ws.onmessage = (event) => resolve(JSON.parse(event.data))
        setTimeout(() => reject(new Error('timeout waiting for invalidation')), 5000)
      })

      await fetch(`${baseUrl}/wystack/api/addItem`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Doohickey' }),
      })

      const msg = await invalidation
      expect(msg.type).toBe('invalidate')
      expect(msg.id).toBe('emb-sub')
    } finally {
      ws.close()
    }
  })

  test('resolveContext works in embedded mode', async () => {
    const pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(
      `CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, name TEXT NOT NULL, active BOOLEAN NOT NULL)`,
    )

    const app = await wy.build({
      db,
      functions: {
        whoami: wy.procedure.input({}).query(async (ctx) => ({ tenant: ctx.tenantId })),
      },
    })

    const embeddedApp = new Hono()
    const wyRoutes = createRoutes(
      {
        app,
        prefix: '/api',
        resolveContext: async (req) => {
          const tenant = req.headers.get('x-tenant-id')
          if (!tenant) throw new Error('Missing tenant')
          return { tenantId: tenant }
        },
      },
      upgradeWebSocket,
    )
    embeddedApp.route('/data', wyRoutes)

    const embServer = Bun.serve({
      fetch: embeddedApp.fetch,
      websocket,
      port: 0,
    })

    try {
      // Without tenant header → 401
      const noTenant = await fetch(`http://localhost:${embServer.port}/data/api/whoami`)
      expect(noTenant.status).toBe(401)

      // With tenant header → context flows through
      const withTenant = await fetch(`http://localhost:${embServer.port}/data/api/whoami`, {
        headers: { 'x-tenant-id': 'acme_corp' },
      })
      const json = await withTenant.json()
      expect(json.data.tenant).toBe('acme_corp')
    } finally {
      embServer.stop(true)
    }
  })
})
