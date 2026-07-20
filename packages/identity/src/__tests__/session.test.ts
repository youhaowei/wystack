import { describe, expect, test } from 'bun:test'
import { createBearerSessionProvider } from '../index'

describe('createBearerSessionProvider', () => {
  test('verifies an Authorization bearer token', async () => {
    const provider = createBearerSessionProvider({
      verify: async (token) =>
        token === 'valid-token' ? { identity: { subject: 'user-1' } } : null,
    })

    const session = await provider.getSession(
      new Request('https://app.test/wystack', {
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
    const queryRequest = new Request('https://app.test/wystack/ws?token=ws-token')
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
        new Request('https://app.test/wystack', {
          headers: { authorization: 'Basic credentials' },
        }),
      ),
    ).resolves.toBeNull()
  })

  test('accepts the bearer scheme in any capitalization (RFC 7235)', async () => {
    const provider = createBearerSessionProvider({
      verify: async (token) =>
        token === 'valid-token' ? { identity: { subject: 'user-1' } } : null,
    })

    for (const scheme of ['Bearer', 'bearer', 'BEARER', 'BeArEr']) {
      await expect(
        provider.getSession(
          new Request('https://app.test/wystack', {
            headers: { authorization: `${scheme} valid-token` },
          }),
        ),
      ).resolves.toEqual({ identity: { subject: 'user-1' } })
    }
  })

  test('a bearer header decides the outcome and is never downgraded to the query token', async () => {
    // A bearer-shaped Authorization header is an explicit assertion of scheme, so
    // its token decides the result; the query token is only consulted when no
    // bearer header is present. Note that an EMPTY bearer token is unreachable
    // here by construction: the Fetch spec strips trailing whitespace from header
    // values, so `Bearer ` arrives as `Bearer` and takes the not-bearer path. The
    // implementation still guards the empty case explicitly rather than relying on
    // that normalization holding across runtimes.
    const provider = createBearerSessionProvider({
      verify: async (token) =>
        token === 'header-token'
          ? { identity: { subject: 'user-header' } }
          : token === 'query-token'
            ? { identity: { subject: 'user-query' } }
            : null,
      allowQueryToken: () => true,
    })

    // Header wins when both are present.
    await expect(
      provider.getSession(
        new Request('https://app.test/wystack?token=query-token', {
          headers: { authorization: 'Bearer header-token' },
        }),
      ),
    ).resolves.toEqual({ identity: { subject: 'user-header' } })

    // A rejected bearer token denies — it does not retry via the query token.
    await expect(
      provider.getSession(
        new Request('https://app.test/wystack?token=query-token', {
          headers: { authorization: 'Bearer wrong-token' },
        }),
      ),
    ).resolves.toBeNull()

    // The query path still applies when no Authorization header is present.
    await expect(
      provider.getSession(new Request('https://app.test/wystack?token=query-token')),
    ).resolves.toEqual({ identity: { subject: 'user-query' } })
  })
})
