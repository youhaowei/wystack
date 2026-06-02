import { describe, test, expect } from 'bun:test'
import { createDispatchInvalidationSource } from '../engine/invalidation-source'
import { createInMemorySubscriptionStore } from '../engine/subscription-store'
import type { SubscriptionEntry } from '../engine/subscription-store'

function entry(overrides: Partial<SubscriptionEntry> = {}): SubscriptionEntry {
  return {
    id: 'sub1',
    functionPath: 'listTodos',
    args: {},
    tablesWatched: new Set(['todos']),
    send: () => {},
    ...overrides,
  }
}

describe('SubscriptionStore', () => {
  test('add and get subscription entries with delivery callbacks', () => {
    const store = createInMemorySubscriptionStore()
    const sent: unknown[] = []
    store.add(entry({ send: (payload) => sent.push(payload) }))

    const sub = store.get('sub1')
    expect(sub).toBeDefined()
    expect(sub?.functionPath).toBe('listTodos')

    sub?.send({ type: 'invalidate', id: 'sub1' })
    expect(sent).toEqual([{ type: 'invalidate', id: 'sub1' }])
  })

  test('add replaces an existing entry with the same subscription id', () => {
    const store = createInMemorySubscriptionStore()
    const sent: unknown[] = []
    store.add(entry({ functionPath: 'oldQuery', send: (payload) => sent.push(['old', payload]) }))
    store.add(entry({ functionPath: 'newQuery', send: (payload) => sent.push(['new', payload]) }))

    const sub = store.get('sub1')
    expect(sub?.functionPath).toBe('newQuery')

    sub?.send({ type: 'invalidate', id: 'sub1' })
    expect(sent).toEqual([['new', { type: 'invalidate', id: 'sub1' }]])
    expect(store.size()).toBe(1)
  })

  test('remove subscription entries', () => {
    const store = createInMemorySubscriptionStore()
    store.add(entry())

    store.remove('sub1')

    expect(store.get('sub1')).toBeUndefined()
  })

  test('getAffected returns every entry whose read tags match written tables', () => {
    const store = createInMemorySubscriptionStore()
    store.add(entry({ id: 'sub1', functionPath: 'listTodos', tablesWatched: new Set(['todos']) }))
    store.add(entry({ id: 'sub2', functionPath: 'listUsers', tablesWatched: new Set(['users']) }))
    store.add(
      entry({
        id: 'sub3',
        functionPath: 'listEverything',
        tablesWatched: new Set(['todos', 'users']),
      }),
    )

    const affected = store.getAffected(new Set(['todos']))

    expect(affected.map((sub) => sub.id).sort()).toEqual(['sub1', 'sub3'])
  })

  test('getAffected returns empty when no read tags match written tables', () => {
    const store = createInMemorySubscriptionStore()
    store.add(entry())

    expect(store.getAffected(new Set(['posts']))).toEqual([])
  })

  test('getAffected returns empty for an empty written table set', () => {
    const store = createInMemorySubscriptionStore()
    store.add(entry({ tablesWatched: new Set(['todos']) }))

    expect(store.getAffected(new Set())).toEqual([])
  })

  test('getAffected excludes entries with no watched tables', () => {
    const store = createInMemorySubscriptionStore()
    store.add(entry({ id: 'sub1', tablesWatched: new Set() }))
    store.add(entry({ id: 'sub2', tablesWatched: new Set(['todos']) }))

    expect(store.getAffected(new Set(['todos'])).map((sub) => sub.id)).toEqual(['sub2'])
  })

  test('size and clear', () => {
    const store = createInMemorySubscriptionStore()
    store.add(entry({ id: 'sub1' }))
    store.add(entry({ id: 'sub2' }))

    expect(store.size()).toBe(2)
    store.clear()
    expect(store.size()).toBe(0)
  })
})

describe('InvalidationSource', () => {
  test('emit notifies a registered handler with the written table set', () => {
    const { source, emit } = createDispatchInvalidationSource()
    const seen: string[][] = []
    source.onInvalidation((tables) => seen.push([...tables].sort()))

    emit(new Set(['todos', 'users']))

    expect(seen).toEqual([['todos', 'users']])
  })

  test('unsubscribe stops future invalidation notifications', () => {
    const { source, emit } = createDispatchInvalidationSource()
    let calls = 0
    const unsubscribe = source.onInvalidation(() => {
      calls += 1
    })

    emit(new Set(['todos']))
    unsubscribe()
    emit(new Set(['todos']))

    expect(calls).toBe(1)
  })

  test('emit notifies multiple handlers independently', () => {
    const { source, emit } = createDispatchInvalidationSource()
    const first: string[][] = []
    const second: string[][] = []
    source.onInvalidation((tables) => {
      tables.add('handler-local')
      first.push([...tables].sort())
    })
    source.onInvalidation((tables) => second.push([...tables].sort()))

    emit(new Set(['todos']))

    expect(first).toEqual([['handler-local', 'todos']])
    expect(second).toEqual([['todos']])
  })

  test('emit snapshots handlers and isolates handler failures', () => {
    const { source, emit } = createDispatchInvalidationSource()
    const seen: string[] = []
    source.onInvalidation(() => {
      seen.push('first')
      source.onInvalidation(() => seen.push('late'))
      throw new Error('subscriber failed')
    })
    source.onInvalidation(() => seen.push('second'))

    emit(new Set(['todos']))
    expect(seen).toEqual(['first', 'second'])

    emit(new Set(['todos']))
    expect(seen).toEqual(['first', 'second', 'first', 'second', 'late'])
  })

  test('emit isolates asynchronous handler rejections', async () => {
    const { source, emit } = createDispatchInvalidationSource()
    const seen: string[] = []
    let rejectionAbsorbed = false
    const rejected = Promise.reject(new Error('async subscriber failed'))
    const originalCatch = rejected.catch.bind(rejected)
    rejected.catch = ((onRejected) => {
      rejectionAbsorbed = true
      return originalCatch(onRejected)
    }) as typeof rejected.catch

    source.onInvalidation(() => {
      seen.push('first')
      return rejected
    })
    source.onInvalidation(() => seen.push('second'))

    emit(new Set(['todos']))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(seen).toEqual(['first', 'second'])
    expect(rejectionAbsorbed).toBe(true)
  })
})
