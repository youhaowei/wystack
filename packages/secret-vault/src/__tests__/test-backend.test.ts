// TestBackend unit tests — verify the in-memory backend's structural
// enforcement of the has-never-decrypts contract independent of SecretVault.

import { describe, test, expect } from 'bun:test'
import { TestBackend } from '../test-backend'

describe('TestBackend', () => {
  test('store returns a locator string', async () => {
    const b = new TestBackend()
    const loc = await b.store('secret')
    expect(typeof loc).toBe('string')
    expect(loc.startsWith('test:')).toBe(true)
  })

  test('store with locatorHint includes hint in locator', async () => {
    const b = new TestBackend()
    const loc = await b.store('secret', 'github-key')
    expect(loc).toContain('github-key')
  })

  test('withSecret resolves the stored plaintext', async () => {
    const b = new TestBackend()
    const loc = await b.store('my-password')
    const result = await b.withSecret(loc, async (p) => p.toUpperCase())
    expect(result).toBe('MY-PASSWORD')
  })

  test('withSecret increments resolveCallCount', async () => {
    const b = new TestBackend()
    const loc = await b.store('x')
    expect(b.resolveCallCount).toBe(0)
    await b.withSecret(loc, async () => null)
    expect(b.resolveCallCount).toBe(1)
  })

  test('has returns true for stored locator WITHOUT incrementing resolveCallCount', async () => {
    const b = new TestBackend()
    const loc = await b.store('value')
    b.resolveCallCount = 0

    const present = await b.has(loc)

    expect(present).toBe(true)
    // The key contract: has must NOT touch the decrypt path
    expect(b.resolveCallCount).toBe(0)
    expect(b.hasCallCount).toBe(1)
  })

  test('has returns false for unknown locator', async () => {
    const b = new TestBackend()
    expect(await b.has('nonexistent')).toBe(false)
  })

  test('delete removes from both store and presence index', async () => {
    const b = new TestBackend()
    const loc = await b.store('to-delete')

    await b.delete(loc)

    expect(await b.has(loc)).toBe(false)
    await expect(b.withSecret(loc, async (p) => p)).rejects.toThrow()
  })

  test('multiple secrets are stored and resolved independently', async () => {
    const b = new TestBackend()
    const locA = await b.store('value-a')
    const locB = await b.store('value-b')

    const a = await b.withSecret(locA, async (p) => p)
    const bVal = await b.withSecret(locB, async (p) => p)

    expect(a).toBe('value-a')
    expect(bVal).toBe('value-b')
  })
})
