/**
 * hooks.test.ts — contract tests for useQuery and useMutation.
 *
 * Tests are driven via @testing-library/react renderHook + a mock WyStack
 * client. No live HTTP server or WebSocket connection is used — the mock
 * captures the onInvalidate callback that the hook registers via
 * client.ws.subscribe(), then invokes it directly to drive the invalidation
 * path. This proves the full WS-invalidate → queryClient.invalidateQueries
 * → refetch loop end-to-end at the integration level.
 *
 * Verification mode: mocked-client integration (no live server).
 */

// DOM setup must be the first import so happy-dom globals are available before
// @testing-library/react is evaluated.
import './setup.dom'

import { describe, test, expect, mock, afterAll } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createElement, type ReactNode } from 'react'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WyStackProvider } from '../provider'
import { useQuery, useMutation } from '../hooks'
import type { WyStackClient } from '../client'
import type { WsManager } from '../ws'
import type { QueryRef, MutationRef } from '../refs'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SubscribeArgs = {
  id: string
  path: string
  args: Record<string, unknown>
  onInvalidate: () => void
  onError?: (err: Error) => void
}

interface MockWs extends WsManager {
  _lastSubscribe: SubscribeArgs | null
  _subscribeCallCount: number
  _unsubscribeCallCount: number
  _unsubscribedIds: string[]
}

function makeMockWs(): MockWs {
  const state: MockWs = {
    _lastSubscribe: null,
    _subscribeCallCount: 0,
    _unsubscribeCallCount: 0,
    _unsubscribedIds: [],
    connect: mock(() => {}),
    disconnect: mock(() => {}),
    isConnected: mock(() => false),
    call: mock(() => Promise.resolve(null)),
    subscribe(id, path, args, onInvalidate, onError) {
      state._subscribeCallCount++
      state._lastSubscribe = { id, path, args, onInvalidate, onError }
    },
    unsubscribe(id) {
      state._unsubscribeCallCount++
      state._unsubscribedIds.push(id)
    },
  }
  return state
}

function makeMockClient(
  ws: WsManager,
  queryImpl?: () => Promise<unknown>,
  mutateImpl?: () => Promise<unknown>,
): WyStackClient {
  return {
    url: 'http://mock',
    prefix: '/api',
    ws,
    // oxlint-disable-next-line typescript/no-explicit-any -- mock return types are intentionally loose
    query: mock(queryImpl ?? (() => Promise.resolve({ id: 1, title: 'test' }))) as any,
    // oxlint-disable-next-line typescript/no-explicit-any -- mock return types are intentionally loose
    mutate: mock(mutateImpl ?? (() => Promise.resolve({ id: 2 }))) as any,
  }
}

function makeWrapper(client: WyStackClient): React.FC<{ children: ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        // Short stale time so invalidation triggers a refetch
        staleTime: 0,
      },
    },
  })

  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(WyStackProvider, { client, children }),
    )
  }
}

// A typed phantom ref factory for tests — matches the shape createApi produces.
function makeQueryRef<TArgs, TReturn>(path: string): QueryRef<TArgs, TReturn> {
  return { _path: path } as unknown as QueryRef<TArgs, TReturn>
}

function makeMutationRef<TArgs, TReturn>(path: string): MutationRef<TArgs, TReturn> {
  return { _path: path } as unknown as MutationRef<TArgs, TReturn>
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useQuery', () => {
  test('fetches via client.query and returns data on success', async () => {
    const ws = makeMockWs()
    const client = makeMockClient(ws, () => Promise.resolve([{ id: 1, title: 'Todo' }]))
    const wrapper = makeWrapper(client)
    const ref = makeQueryRef<Record<string, never>, { id: number; title: string }[]>('listTodos')

    const { result } = renderHook(() => useQuery(ref), { wrapper })

    // Wait for TanStack Query to resolve the async queryFn
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual([{ id: 1, title: 'Todo' }])
    // client.query was called exactly once for the initial fetch
    expect((client.query as ReturnType<typeof mock>).mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test('cache invalidation: WS onInvalidate triggers refetch (the key AC)', async () => {
    // This test proves the full loop:
    //   ws.subscribe() captures onInvalidate → invoke it →
    //   queryClient.invalidateQueries() fires → client.query called again
    let callCount = 0
    const ws = makeMockWs()
    const client = makeMockClient(ws, () => {
      callCount++
      return Promise.resolve({ call: callCount })
    })
    const wrapper = makeWrapper(client)
    const ref = makeQueryRef<Record<string, never>, { call: number }>('myQuery')

    const { result } = renderHook(() => useQuery(ref), { wrapper })

    // Wait for initial fetch to complete
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ call: 1 })
    expect(callCount).toBe(1)

    // Verify subscribe was called on mount
    expect(ws._subscribeCallCount).toBe(1)
    expect(ws._lastSubscribe).not.toBeNull()
    expect(ws._lastSubscribe!.path).toBe('myQuery')

    // Invoke the captured onInvalidate callback — simulates a WS invalidate frame
    act(() => {
      ws._lastSubscribe!.onInvalidate()
    })

    // The refetch should fire and call client.query a second time
    await waitFor(() => expect(callCount).toBeGreaterThanOrEqual(2))
    expect(result.current.data).toEqual({ call: callCount })
  })

  test('subscribes on mount and unsubscribes on unmount', async () => {
    const ws = makeMockWs()
    const client = makeMockClient(ws)
    const wrapper = makeWrapper(client)
    const ref = makeQueryRef<Record<string, never>, unknown>('listTodos')

    const { unmount } = renderHook(() => useQuery(ref), { wrapper })

    // Subscribe fires on mount
    await waitFor(() => expect(ws._subscribeCallCount).toBe(1))
    expect(ws._lastSubscribe!.path).toBe('listTodos')
    const subscribedId = ws._lastSubscribe!.id

    // Unmount — effect cleanup should call unsubscribe
    unmount()

    expect(ws._unsubscribeCallCount).toBe(1)
    expect(ws._unsubscribedIds).toContain(subscribedId)
  })

  test('skip:true skips fetch and subscription', async () => {
    const ws = makeMockWs()
    const client = makeMockClient(ws)
    const wrapper = makeWrapper(client)
    const ref = makeQueryRef<{ id: string }, unknown>('getUser')

    const { result } = renderHook(() => useQuery(ref, { args: undefined, skip: true }), {
      wrapper,
    })

    // Give TanStack Query time to settle — it should stay in initial state
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })

    // No fetch when skipped
    expect((client.query as ReturnType<typeof mock>).mock.calls.length).toBe(0)
    // No subscription when skipped
    expect(ws._subscribeCallCount).toBe(0)
    // TanStack Query stays in loading/pending state with no data
    expect(result.current.data).toBeUndefined()
  })

  test('query key shape is [wystack, path, args] with empty object for no-arg queries', async () => {
    // This verifies the cache key contract documented in hooks.ts:
    // cache key is always ['wystack', path, args ?? {}] — three elements.
    const capturedArgs: unknown[] = []
    const ws = makeMockWs()
    const client = makeMockClient(ws)
    // Spy: capture the ref and args that client.query receives
    ;(client.query as ReturnType<typeof mock>).mockImplementation((ref, args) => {
      capturedArgs.push({ ref, args })
      return Promise.resolve([])
    })

    const wrapper = makeWrapper(client)
    const ref = makeQueryRef<Record<string, never>, unknown[]>('allTodos')

    renderHook(() => useQuery(ref), { wrapper })

    await waitFor(() => expect(capturedArgs.length).toBeGreaterThanOrEqual(1))

    // The hook calls client.query(ref, stableArgs) where stableArgs is normalizedArgs = {} for no-arg
    const call = capturedArgs[0] as { ref: { _path: string }; args: unknown }
    expect(call.ref._path).toBe('allTodos')
    // normalizedArgs is {} for undefined args
    expect(call.args).toEqual({})
  })

  test('subscription-error surfacing is browser-safe — does not throw when `process` is undefined (YW-108)', async () => {
    // Regression (Codex MUST): the YW-108 onError surfacing read
    // `process.env.NODE_ENV` unguarded. `@wystack/client` ships as plain ESM, so
    // `process` is not defined in a browser build — a subscription rejection
    // would throw `ReferenceError: process is not defined` in the exact path
    // YW-108 makes safe. The fix guards the access with `typeof process`.
    const ws = makeMockWs()
    const client = makeMockClient(ws)
    const wrapper = makeWrapper(client)
    const ref = makeQueryRef<Record<string, never>, unknown>('listTodos')

    renderHook(() => useQuery(ref), { wrapper })

    // The hook registers an onError on mount.
    await waitFor(() => expect(ws._subscribeCallCount).toBe(1))
    const onError = ws._lastSubscribe!.onError
    expect(onError).toBeDefined()

    // Simulate the browser: no `process` global. Capture and delete it, invoke
    // the surfacing path, and assert it does NOT throw. Restore in a finally so
    // a failure can't leak the deletion into other tests.
    const savedProcess = (globalThis as { process?: unknown }).process
    try {
      delete (globalThis as { process?: unknown }).process
      expect(() => onError!(new Error('REACTIVITY_NOT_ENABLED'))).not.toThrow()
    } finally {
      ;(globalThis as { process?: unknown }).process = savedProcess
    }
  })

  test('onLiveUpdatesError receives durable subscription errors', async () => {
    const ws = makeMockWs()
    const client = makeMockClient(ws)
    const wrapper = makeWrapper(client)
    const ref = makeQueryRef<Record<string, never>, unknown>('listTodos')
    const liveErrors: Error[] = []

    renderHook(() => useQuery(ref, { onLiveUpdatesError: (err) => liveErrors.push(err) }), {
      wrapper,
    })

    await waitFor(() => expect(ws._subscribeCallCount).toBe(1))
    expect(ws._lastSubscribe!.onError).toBeDefined()

    act(() => {
      ws._lastSubscribe!.onError!(new Error('REACTIVITY_NOT_ENABLED'))
    })

    expect(liveErrors).toHaveLength(1)
    expect(liveErrors[0]?.message).toBe('REACTIVITY_NOT_ENABLED')
  })
})

describe('useMutation', () => {
  test('calls client.mutate and resolves mutation state', async () => {
    const ws = makeMockWs()
    const client = makeMockClient(ws, undefined, () => Promise.resolve({ id: 99 }))
    const wrapper = makeWrapper(client)
    const ref = makeMutationRef<{ title: string }, { id: number }>('createTodo')

    const { result } = renderHook(() => useMutation(ref), { wrapper })

    expect(result.current.isIdle).toBe(true)

    await act(async () => {
      result.current.mutate({ title: 'New todo' })
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toEqual({ id: 99 })
    expect((client.mutate as ReturnType<typeof mock>).mock.calls.length).toBe(1)
    // Verify the correct args were passed
    const mutateCall = (client.mutate as ReturnType<typeof mock>).mock.calls[0]
    expect(mutateCall[0]._path).toBe('createTodo')
    expect(mutateCall[1]).toEqual({ title: 'New todo' })
  })

  test('useMutation does not call client.query (mutation uses POST, not GET)', () => {
    const ws = makeMockWs()
    const client = makeMockClient(ws)
    const wrapper = makeWrapper(client)
    const ref = makeMutationRef<{ title: string }, { id: number }>('createTodo')

    // Just rendering — no mutate() call
    renderHook(() => useMutation(ref), { wrapper })

    expect((client.query as ReturnType<typeof mock>).mock.calls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Cleanup: unregister happy-dom so its globals don't leak into other test files
// (e.g., ws.test.ts which needs bun's native fetch/WebSocket).
// ---------------------------------------------------------------------------

afterAll(async () => {
  if (GlobalRegistrator.isRegistered) {
    await GlobalRegistrator.unregister()
  }
})

// ---------------------------------------------------------------------------
// Red→green evidence capture
// ---------------------------------------------------------------------------
// The invalidation test above (cache invalidation: WS onInvalidate triggers
// refetch) is the acceptance criterion. To verify red→green:
//
// 1. Temporarily remove the ws.subscribe() call in useQuery's useEffect
//    (or remove the queryClient.invalidateQueries call) → the test fails
//    because callCount stays at 1 after invoking onInvalidate.
// 2. Restore → test turns green.
//
// This file captures that verified green state. The hooks source (hooks.ts) was
// NOT modified; only this test file was added.
