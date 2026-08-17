import { describe, expect, test } from 'bun:test'
import { upgradeWebSocket } from 'hono/bun'
import { createDispatchInvalidationSource } from '../engine'
import { createRoutes } from '../routes'
import { createSubscriptionManager } from '../subscriptions'
import type { FunctionDef } from '../types'
import type { WyStackApp } from '../create'

function createTestApp(): WyStackApp {
  const invalidation = createDispatchInvalidationSource()
  return {
    functions: new Map<string, FunctionDef>([['listTodos', { type: 'query' } as FunctionDef]]),
    subscriptions: createSubscriptionManager(),
    invalidationSource: invalidation.source,
    emit: invalidation.emit,
    call: async () => ({ result: [], tablesRead: new Set(), tablesWritten: new Set() }),
    runHandler: async () => [],
    createTracked: () => {
      throw new Error('not used')
    },
  }
}

function createCorsRoutes() {
  return createRoutes(
    {
      app: createTestApp(),
      cors: { origins: ['https://app.example'] },
    },
    upgradeWebSocket,
  )
}

describe('CORS response policy', () => {
  test('approved preflight allows only the public transport headers and varies by origin', async () => {
    const routes = createCorsRoutes()
    const response = await routes.fetch(
      new Request('http://localhost/api/listTodos', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example',
          'Access-Control-Request-Headers': 'authorization, x-wystack-context, x-auth-request-user',
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example')
    const allowedHeaders = response.headers.get('access-control-allow-headers')
    expect(allowedHeaders).toContain('Authorization')
    expect(allowedHeaders).toContain('X-WyStack-Context')
    expect(allowedHeaders).not.toContain('X-Auth-Request-User')
    expect(response.headers.get('vary')).toContain('Origin')
  })

  test('validates client context separately from request identity', async () => {
    const seen: Array<{
      tenantId: unknown
      authorization: string | null
      cookie: string | null
      proxyUser: string | null
      rawContext: string | null
    }> = []
    const routes = createRoutes(
      {
        app: createTestApp(),
        validateClientContext: (value) => {
          if (typeof value.tenantId !== 'string') throw new Error('tenantId is required')
          return { tenantId: value.tenantId }
        },
        trustedRequestHeaders: ['X-WyStack-Context'],
        resolveContext: async (request, clientContext) => {
          seen.push({
            tenantId: clientContext.tenantId,
            authorization: request.headers.get('authorization'),
            cookie: request.headers.get('cookie'),
            proxyUser: request.headers.get('x-auth-request-user'),
            rawContext: request.headers.get('x-wystack-context'),
          })
          return {}
        },
      },
      upgradeWebSocket,
    )

    const response = await routes.fetch(
      new Request('http://localhost/api/listTodos', {
        headers: {
          Authorization: 'Bearer signed-token',
          Cookie: 'session=signed-cookie',
          'X-Auth-Request-User': 'direct-admin@example.com',
          'X-WyStack-Context': JSON.stringify({
            tenantId: 'acme',
            'X-Auth-Request-User': 'admin@example.com',
          }),
        },
      }),
    )

    expect(response.status).toBe(200)
    expect(seen).toEqual([
      {
        tenantId: 'acme',
        authorization: 'Bearer signed-token',
        cookie: 'session=signed-cookie',
        proxyUser: null,
        rawContext: null,
      },
    ])
  })

  test('exposes an ingress-owned identity header only through explicit server policy', async () => {
    const seen: Array<string | null> = []
    const routes = createRoutes(
      {
        app: createTestApp(),
        trustedRequestHeaders: ['X-Auth-Request-User'],
        resolveContext: async (request) => {
          seen.push(request.headers.get('x-auth-request-user'))
          return {}
        },
      },
      upgradeWebSocket,
    )

    const response = await routes.fetch(
      new Request('http://localhost/api/listTodos', {
        headers: { 'X-Auth-Request-User': 'verified@example.com' },
      }),
    )

    expect(response.status).toBe(200)
    expect(seen).toEqual(['verified@example.com'])
  })

  test('rejects a client context envelope when no validator is configured', async () => {
    const response = await createCorsRoutes().fetch(
      new Request('http://localhost/api/listTodos', {
        headers: { 'X-WyStack-Context': JSON.stringify({ tenantId: 'acme' }) },
      }),
    )

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: 'Client context is not configured on this server',
    })
  })

  test('actual responses always vary by origin and reflect only trusted origins', async () => {
    const routes = createCorsRoutes()

    const sameOrigin = await routes.fetch(new Request('http://localhost/api/listTodos'))
    expect(sameOrigin.headers.get('vary')).toContain('Origin')
    expect(sameOrigin.headers.get('access-control-allow-origin')).toBeNull()

    const trusted = await routes.fetch(
      new Request('http://localhost/api/listTodos', {
        headers: { Origin: 'https://app.example' },
      }),
    )
    expect(trusted.headers.get('access-control-allow-origin')).toBe('https://app.example')

    const untrusted = await routes.fetch(
      new Request('http://localhost/api/listTodos', {
        headers: { Origin: 'https://attacker.example' },
      }),
    )
    expect(untrusted.headers.get('access-control-allow-origin')).toBeNull()
    expect(untrusted.headers.get('vary')).toContain('Origin')
  })
})
