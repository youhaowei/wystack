import { describe, test, expect } from 'bun:test'
import type { QueryDef, MutationDef, FunctionDef } from '@wystack/server'
import type { ProxyClient } from '../proxy'

// ---------------------------------------------------------------------------
// Type-level tests — if these compile, the type system is correct
// ---------------------------------------------------------------------------

// Simulated server function map (type-only — no runtime import)
type TestFunctions = {
  listTodos: QueryDef<Record<string, never>, { id: number; title: string }[]>
  addTodo: MutationDef<{ title: string }, { id: number }>
}

// Verify the mapped type resolves correctly
type Api = ProxyClient<TestFunctions>

// These assertions run at compile time — if proxy.ts types are wrong, this file won't compile
const _typeTests = {} as Api

// Query proxy has useQuery
const _queryProxy = _typeTests.listTodos
type _QueryResult = ReturnType<typeof _queryProxy.useQuery>

// Mutation proxy has useMutation
const _mutationProxy = _typeTests.addTodo
type _MutationResult = ReturnType<typeof _mutationProxy.useMutation>

// @ts-expect-error — query proxy should NOT have useMutation
const _badQuery: typeof _queryProxy.useMutation = undefined

// @ts-expect-error — mutation proxy should NOT have useQuery
const _badMutation: typeof _mutationProxy.useQuery = undefined

// ---------------------------------------------------------------------------
// Runtime tests — verify Proxy behavior
// ---------------------------------------------------------------------------

describe('createWyClient proxy', () => {
  // We can't call useQuery/useMutation outside React, but we CAN test
  // that the proxy returns objects with the right shape.

  test('proxy returns object with useQuery and useMutation for any path', async () => {
    // Import at runtime for proxy construction test
    const { createWyClient } = await import('../proxy')

    const { api } = createWyClient<TestFunctions>({
      url: 'http://localhost:9999',
    })

    // Proxy intercepts property access and returns hook accessors
    const listTodos = api.listTodos
    expect(typeof listTodos.useQuery).toBe('function')

    const addTodo = api.addTodo
    expect(typeof addTodo.useMutation).toBe('function')
  })

  test('proxy returns same shape for any string path', async () => {
    const { createWyClient } = await import('../proxy')

    const { api } = createWyClient<Record<string, FunctionDef>>({
      url: 'http://localhost:9999',
    })

    // Even unknown paths return proxy objects (runtime doesn't validate — types do)
    // oxlint-disable-next-line typescript/no-explicit-any -- testing dynamic proxy access on untyped paths
    const arbitrary = (api as any).somePath
    expect(typeof arbitrary.useQuery).toBe('function')
    expect(typeof arbitrary.useMutation).toBe('function')
  })

  test('proxy ignores symbol access', async () => {
    const { createWyClient } = await import('../proxy')

    const { api } = createWyClient<TestFunctions>({
      url: 'http://localhost:9999',
    })

    // Symbol access (e.g., from React DevTools) should return undefined
    // oxlint-disable-next-line typescript/no-explicit-any -- testing symbol access on proxy requires type escape
    expect((api as any)[Symbol.iterator]).toBeUndefined()
  })

  test('createWyClient returns a client alongside the api', async () => {
    const { createWyClient } = await import('../proxy')

    const { client, api } = createWyClient<TestFunctions>({
      url: 'http://localhost:9999',
      prefix: '/rpc',
    })

    expect(client.url).toBe('http://localhost:9999')
    expect(client.prefix).toBe('/rpc')
    expect(api).toBeDefined()
  })
})
