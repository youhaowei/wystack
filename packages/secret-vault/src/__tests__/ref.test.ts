import { describe, test, expect } from 'bun:test'
import { makeSecretRef, isSecretRef } from '../ref'

describe('SecretRef', () => {
  test('makeSecretRef mints a ref with the secret: prefix', () => {
    const ref = makeSecretRef()
    expect(ref.startsWith('secret:')).toBe(true)
  })

  test('makeSecretRef mints unique refs', () => {
    const refs = new Set(Array.from({ length: 100 }, () => makeSecretRef()))
    expect(refs.size).toBe(100)
  })

  test('makeSecretRef produces a valid UUID after the prefix', () => {
    const ref = makeSecretRef()
    const uuid = ref.slice('secret:'.length)
    // UUID v4 pattern: 8-4-4-4-12 hex chars
    expect(uuid).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i)
  })

  test('isSecretRef returns true for a valid ref', () => {
    expect(isSecretRef(makeSecretRef())).toBe(true)
  })

  test('isSecretRef returns false for non-ref strings', () => {
    expect(isSecretRef('plain-string')).toBe(false)
    expect(isSecretRef('secret:')).toBe(false) // prefix only, no UUID
    expect(isSecretRef('')).toBe(false)
    expect(isSecretRef(null)).toBe(false)
    expect(isSecretRef(42)).toBe(false)
    expect(isSecretRef(undefined)).toBe(false)
  })

  test('isSecretRef returns false for prefix + malformed UUID', () => {
    // The prefix alone must not satisfy the guard — the suffix is validated
    // as a v4 UUID. Closes the false-positive path on the public type guard.
    expect(isSecretRef('secret:not-a-uuid')).toBe(false)
    expect(isSecretRef('secret:12345')).toBe(false)
    // Right shape but wrong version nibble (v1, not v4) — still rejected.
    expect(isSecretRef('secret:00000000-0000-1000-8000-000000000000')).toBe(false)
  })
})
