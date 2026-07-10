import { describe, expect, test } from 'bun:test'
import { createSessionResolver, type SessionProvider } from './index'

const request = new Request('https://workhub.test/wystack/ws')

function provider(session: Awaited<ReturnType<SessionProvider['getSession']>>): SessionProvider {
  return { getSession: async () => session }
}

describe('createSessionResolver', () => {
  test('uses the configured local provider and returns its verified identity', async () => {
    const resolveSession = createSessionResolver({
      mode: 'local',
      local: provider({ identity: { subject: 'user-local', email: 'local@example.com' } }),
    })

    await expect(resolveSession(request)).resolves.toEqual({
      identity: { subject: 'user-local', email: 'local@example.com' },
    })
  })

  test('uses a remote provider only when remote mode is selected', async () => {
    const resolveSession = createSessionResolver({
      mode: 'remote',
      remote: provider({ identity: { subject: 'lumony-user' } }),
    })

    await expect(resolveSession(request)).resolves.toEqual({ identity: { subject: 'lumony-user' } })
  })

  test('fails closed when a configured provider is unavailable', async () => {
    const resolveSession = createSessionResolver({ mode: 'remote' })

    await expect(resolveSession(request)).rejects.toThrow(
      'No remote session provider is configured',
    )
  })
})
