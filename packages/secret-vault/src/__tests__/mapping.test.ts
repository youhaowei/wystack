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
})
