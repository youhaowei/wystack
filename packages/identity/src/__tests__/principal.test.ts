import { describe, expect, test } from 'bun:test'
import { isPrincipal, type Principal, type PrincipalKind } from '../index'

describe('Principal', () => {
  test('narrows to the user variant on kind', () => {
    const principal: Principal = {
      kind: 'user',
      userId: 'user-1',
      identity: { subject: 'auth0|abc', email: 'user@example.test' },
    }

    if (principal.kind !== 'user') throw new Error('expected a user principal')

    // Variant-only fields are reachable only inside the narrow — tsc is the assertion.
    expect(principal.userId).toBe('user-1')
    expect(principal.identity?.subject).toBe('auth0|abc')
  })

  test('narrows to the service variant on kind', () => {
    const principal: Principal = { kind: 'service', credentialId: 'cred-1' }

    if (principal.kind !== 'service') throw new Error('expected a service principal')

    expect(principal.credentialId).toBe('cred-1')
  })

  test('a user principal carries no identity when the provider supplied none', () => {
    const principal: Principal = { kind: 'user', userId: 'user-2' }

    if (principal.kind !== 'user') throw new Error('expected a user principal')

    expect(principal.identity).toBeUndefined()
  })

  test('discriminates a mixed collection by kind', () => {
    const principals: Principal[] = [
      { kind: 'user', userId: 'user-1' },
      { kind: 'service', credentialId: 'cred-1' },
    ]

    const ids = principals.map((principal) =>
      principal.kind === 'user' ? principal.userId : principal.credentialId,
    )

    expect(ids).toEqual(['user-1', 'cred-1'])
  })

  test('exports the Principal kind union', () => {
    const kinds: PrincipalKind[] = ['user', 'service']

    expect(kinds).toEqual(['user', 'service'])
  })
})

describe('isPrincipal', () => {
  test.each([undefined, null, true, 1, 'user'])('rejects non-objects: %p', (value) => {
    expect(isPrincipal(value)).toBe(false)
  })

  test('rejects an object with no kind', () => {
    expect(isPrincipal({ userId: 'user-1' })).toBe(false)
  })

  test.each([{}, { userId: '' }, { userId: 1 }])(
    'rejects a malformed user principal: %p',
    (fields) => {
      expect(isPrincipal({ kind: 'user', ...fields })).toBe(false)
    },
  )

  test.each([{}, { credentialId: '' }, { credentialId: 1 }])(
    'rejects a malformed service principal: %p',
    (fields) => {
      expect(isPrincipal({ kind: 'service', ...fields })).toBe(false)
    },
  )

  test.each(['robot', '__proto__', 'toString'])('rejects an unknown kind: %s', (kind) => {
    expect(isPrincipal({ kind, credentialId: 'cred-1' })).toBe(false)
  })

  test('rejects values whose property inspection throws', () => {
    const principal = new Proxy(
      {},
      {
        get() {
          throw new Error('inspection failed')
        },
      },
    )

    expect(isPrincipal(principal)).toBe(false)
  })

  test('accepts a user principal with a non-empty userId', () => {
    expect(isPrincipal({ kind: 'user', userId: 'user-1' })).toBe(true)
  })

  test('accepts a service principal with a non-empty credentialId', () => {
    expect(isPrincipal({ kind: 'service', credentialId: 'cred-1' })).toBe(true)
  })
})
