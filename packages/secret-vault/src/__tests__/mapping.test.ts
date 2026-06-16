// InMemoryMappingStore unit tests.

import { describe, test, expect } from 'bun:test'
import { InMemoryMappingStore } from '../mapping'
import { makeSecretRef } from '../ref'

describe('InMemoryMappingStore', () => {
  test('set and get round-trip', async () => {
    const store = new InMemoryMappingStore()
    const ref = makeSecretRef()
    await store.set(ref, { backend: 'test', locator: 'loc-1' })
    const record = await store.get(ref)
    expect(record).toEqual({ backend: 'test', locator: 'loc-1' })
  })

  test('get returns undefined for unknown ref', async () => {
    const store = new InMemoryMappingStore()
    const ref = makeSecretRef()
    expect(await store.get(ref)).toBeUndefined()
  })

  test('has returns true for stored ref', async () => {
    const store = new InMemoryMappingStore()
    const ref = makeSecretRef()
    await store.set(ref, { backend: 'b', locator: 'l' })
    expect(await store.has(ref)).toBe(true)
  })

  test('has returns false for absent ref', async () => {
    const store = new InMemoryMappingStore()
    expect(await store.has(makeSecretRef())).toBe(false)
  })

  test('delete removes the record', async () => {
    const store = new InMemoryMappingStore()
    const ref = makeSecretRef()
    await store.set(ref, { backend: 'b', locator: 'l' })
    await store.delete(ref)
    expect(await store.has(ref)).toBe(false)
    expect(await store.get(ref)).toBeUndefined()
  })

  test('multiple refs are independent', async () => {
    const store = new InMemoryMappingStore()
    const ref1 = makeSecretRef()
    const ref2 = makeSecretRef()
    await store.set(ref1, { backend: 'b', locator: 'l1' })
    await store.set(ref2, { backend: 'b', locator: 'l2' })
    expect((await store.get(ref1))?.locator).toBe('l1')
    expect((await store.get(ref2))?.locator).toBe('l2')
  })

  test('get returns an independent copy — mutating it does not corrupt the store', async () => {
    const store = new InMemoryMappingStore()
    const ref = makeSecretRef()
    await store.set(ref, { backend: 'orig-backend', locator: 'orig-locator' })

    const fetched = await store.get(ref)
    // MappingRecord is readonly at compile time; a JS caller (or a cast) can
    // still mutate at runtime. The store must not be reachable through it.
    ;(fetched as { backend: string; locator: string }).backend = 'hijacked'
    ;(fetched as { backend: string; locator: string }).locator = 'hijacked'

    const again = await store.get(ref)
    expect(again?.backend).toBe('orig-backend')
    expect(again?.locator).toBe('orig-locator')
  })

  test('set copies the input — mutating the caller object does not corrupt the store', async () => {
    const store = new InMemoryMappingStore()
    const ref = makeSecretRef()
    const input = { backend: 'orig-backend', locator: 'orig-locator' }
    await store.set(ref, input)

    // Mutate the object the caller passed to set() after the fact.
    input.backend = 'hijacked'
    input.locator = 'hijacked'

    const stored = await store.get(ref)
    expect(stored?.backend).toBe('orig-backend')
    expect(stored?.locator).toBe('orig-locator')
  })
})
