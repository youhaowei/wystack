import { describe, expect, test } from 'bun:test'
import { createBearerSessionProvider } from './index'

describe('createBearerSessionProvider', () => {
  test('verifies an Authorization bearer token', async () => {
    const provider = createBearerSessionProvider({
      verify: async (token) =>
        token === 'valid-token' ? { identity: { subject: 'user-1' } } : null,
    })

    const session = await provider.getSession(
      new Request('https://workhub.test/wystack', {
        headers: { authorization: 'Bearer valid-token' },
      }),
    )

    expect(session).toEqual({ identity: { subject: 'user-1' } })
  })

  test('accepts a query token only when explicitly enabled for websocket handshakes', async () => {
    const verify = async (token: string) =>
      token === 'ws-token' ? { identity: { subject: 'user-ws' } } : null

    const httpProvider = createBearerSessionProvider({ verify })
    const websocketProvider = createBearerSessionProvider({
      verify,
      allowQueryToken: (request) => request.headers.get('upgrade') === 'websocket',
    })
    const queryRequest = new Request('https://workhub.test/wystack/ws?token=ws-token')
    const upgradeRequest = new Request(queryRequest, { headers: { upgrade: 'websocket' } })

    await expect(httpProvider.getSession(queryRequest)).resolves.toBeNull()
    await expect(websocketProvider.getSession(queryRequest)).resolves.toBeNull()
    await expect(websocketProvider.getSession(upgradeRequest)).resolves.toEqual({
      identity: { subject: 'user-ws' },
    })
  })

  test('fails closed for malformed bearer headers', async () => {
    const provider = createBearerSessionProvider({
      verify: async () => ({ identity: { subject: 'unexpected' } }),
    })

    await expect(
      provider.getSession(
        new Request('https://workhub.test/wystack', {
          headers: { authorization: 'Basic credentials' },
        }),
      ),
    ).resolves.toBeNull()
  })
})
