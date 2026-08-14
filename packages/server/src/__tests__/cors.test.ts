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
  test('approved preflight reflects requested headers and varies by origin', async () => {
    const routes = createCorsRoutes()
    const response = await routes.fetch(
      new Request('http://localhost/api/listTodos', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.example',
          'Access-Control-Request-Headers': 'authorization, x-tenant-id',
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(response.headers.get('access-control-allow-headers')).toBe('authorization, x-tenant-id')
    expect(response.headers.get('vary')).toContain('Origin')
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
