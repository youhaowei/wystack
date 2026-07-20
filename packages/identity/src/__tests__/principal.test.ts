import { describe, expect, test } from 'bun:test'
import type { Principal } from '../index'

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
})
