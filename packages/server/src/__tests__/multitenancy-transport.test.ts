import { expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, multiTenant, syncSchema, text, uuid } from '@wystack/db'
import { defineApp } from '../define-app'
import { serve } from '../serve-bun'

const tenancy = multiTenant({
  key: { property: 'workspaceId', column: 'workspace_id', type: text },
})
const schema = defineSchema({
  insights: tenancy.table({ id: uuid.primaryKey(), name: text }),
})
const wy = defineApp<Record<string, unknown>>({ permissions: {} })

test('HTTP and WebSocket requests resolve tenant scope before procedure access', async () => {
  const client = new PGlite()
  await client.waitReady
  const db = drizzle(client)
  await syncSchema(db, schema)

  const observedReads: string[][] = []
  const app = await wy.build({
    db,
    tenancy,
    resolveTenant(context) {
      const tenantId = context.tenantId
      if (tenantId !== 'alpha' && tenantId !== 'beta') throw new Error('tenant access denied')
      return tenantId
    },
    functions: {
      addInsight: wy.procedure
        .input({ id: uuid, name: text })
        .mutation(async (ctx, args) => ctx.db.into(schema.insights).insert(args)),
      listInsights: wy.procedure.input({}).query(async (ctx) => {
        const rows = await ctx.db.from(schema.insights).all()
        observedReads.push(rows.map((row) => row.name))
        return rows
      }),
    },
  })
  await app.call(
    'addInsight',
    { id: '00000000-0000-4000-8000-000000000001', name: 'alpha only' },
    { tenantId: 'alpha' },
  )
  await app.call(
    'addInsight',
    { id: '00000000-0000-4000-8000-000000000002', name: 'beta only' },
    { tenantId: 'beta' },
  )

  const server = serve({
    app,
    port: 0,
    resolveContext(request) {
      const tenantId = request.headers.get('authorization')?.replace('Bearer ', '')
      if (tenantId !== 'alpha' && tenantId !== 'beta') throw new Error('tenant access denied')
      return { tenantId }
    },
  })
  await server.ready

  try {
    const response = await fetch(`http://localhost:${server.port}/api/listInsights`, {
      headers: { Authorization: 'Bearer alpha' },
    })
    expect(response.status).toBe(200)
    expect((await response.json()).data.map((row: { name: string }) => row.name)).toEqual([
      'alpha only',
    ])

    const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('tenant WebSocket smoke timeout')), 5000)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: 'beta' }))
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data))
        if (message.type === 'authenticated') {
          ws.send(
            JSON.stringify({
              type: 'subscribe',
              id: 'tenant-proof',
              path: 'listInsights',
              args: {},
            }),
          )
        }
        if (message.type === 'subscribed') {
          clearTimeout(timeout)
          resolve()
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('tenant WebSocket smoke failed'))
      }
    })
    ws.close()

    expect(observedReads).toEqual([['alpha only'], ['beta only']])
  } finally {
    server.stop(true)
    await client.close()
  }
})
