import { describe, test, expect } from 'bun:test'
import type { QueryDef, MutationDef } from '@wystack/server'
import type { QueryRef, MutationRef, ApiFromFunctions } from '../refs'
import { createApi } from '../api'

// ---------------------------------------------------------------------------
// Type-level tests — if these compile, the type system is correct
// ---------------------------------------------------------------------------

type TestFunctions = {
  listTodos: QueryDef<{ orgId: string }, { id: number; title: string }[]>
  getTodo: QueryDef<{ id: number }, { id: number; title: string }>
  createTodo: MutationDef<{ title: string }, { id: number }>
  deleteTodo: MutationDef<{ id: number }, void>
}

type Api = ApiFromFunctions<TestFunctions>

// Queries map to QueryRef
const _listTodos: Api['listTodos'] extends QueryRef<
  { orgId: string },
  { id: number; title: string }[]
>
  ? true
  : never = true

// Mutations map to MutationRef
const _createTodo: Api['createTodo'] extends MutationRef<{ title: string }, { id: number }>
  ? true
  : never = true

// QueryRef is NOT a MutationRef
const _notMutation: Api['listTodos'] extends MutationRef ? never : true = true

// MutationRef is NOT a QueryRef
const _notQuery: Api['createTodo'] extends QueryRef ? never : true = true

test('maps function definitions to typed refs', () => {
  expect(_listTodos).toBe(true)
  expect(_createTodo).toBe(true)
  expect(_notMutation).toBe(true)
  expect(_notQuery).toBe(true)
})

// ---------------------------------------------------------------------------
// Runtime tests — verify Proxy behavior
// ---------------------------------------------------------------------------

describe('createApi proxy', () => {
  test('returns objects with _path for each key', () => {
    const api = createApi<TestFunctions>()

    expect(api.listTodos._path).toBe('listTodos')
    expect(api.getTodo._path).toBe('getTodo')
    expect(api.createTodo._path).toBe('createTodo')
    expect(api.deleteTodo._path).toBe('deleteTodo')
  })

  test('returns undefined for symbol access', () => {
    const api = createApi<TestFunctions>()

    // Symbol access (e.g., React DevTools) should return undefined
    // oxlint-disable-next-line typescript/no-explicit-any -- testing symbol access
    expect((api as any)[Symbol.iterator]).toBeUndefined()
  })

  test('refs are plain objects with only _path at runtime', () => {
    const api = createApi<TestFunctions>()

    const ref = api.listTodos
    expect(Object.keys(ref)).toEqual(['_path'])
    expect(ref._path).toBe('listTodos')
  })
})

describe('createWyStack', () => {
  test('returns api, client, and Provider', async () => {
    const { createWyStack } = await import('../setup')

    const instance = createWyStack<TestFunctions>({
      url: 'http://localhost:9999',
    })

    expect(instance.api).toBeDefined()
    expect(instance.client).toBeDefined()
    expect(instance.Provider).toBeDefined()

    // api refs work
    expect(instance.api.listTodos._path).toBe('listTodos')
    expect(instance.api.createTodo._path).toBe('createTodo')

    // client has expected shape
    expect(instance.client.url).toBe('http://localhost:9999')
    expect(typeof instance.client.query).toBe('function')
    expect(typeof instance.client.mutate).toBe('function')
  })

  test('respects custom prefix', async () => {
    const { createWyStack } = await import('../setup')

    const { client } = createWyStack<TestFunctions>({
      url: 'http://localhost:9999',
      prefix: '/rpc',
    })

    expect(client.prefix).toBe('/rpc')
  })

  test('raw client accepts typed refs for imperative calls', async () => {
    const { createWyStack } = await import('../setup')
    const originalFetch = globalThis.fetch
    const requestedUrls: string[] = []
    const requestedBodies: string[] = []

    globalThis.fetch = (async (input, init) => {
      requestedUrls.push(String(input))
      if (init?.body) requestedBodies.push(String(init.body))
      return new Response(
        JSON.stringify({ data: input.toString().includes('listTodos') ? [] : { id: 1 } }),
      )
    }) as typeof fetch

    try {
      const { api, client } = createWyStack<TestFunctions>({
        url: 'http://localhost:9999',
      })

      const queryResult = client.query(api.listTodos, { orgId: 'org_123' })
      const mutationResult = client.mutate(api.createTodo, { title: 'Ship typed refs' })

      const _queryPromise: Promise<{ id: number; title: string }[]> = queryResult
      const _mutationPromise: Promise<{ id: number }> = mutationResult

      expect(await _queryPromise).toEqual([])
      expect(await _mutationPromise).toEqual({ id: 1 })
      expect(requestedUrls[0]).toContain('/api/listTodos?')
      expect(requestedUrls[1]).toBe('http://localhost:9999/api/createTodo')
      expect(requestedBodies).toEqual([JSON.stringify({ title: 'Ship typed refs' })])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
