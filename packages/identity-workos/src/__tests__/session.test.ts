import { afterEach, describe, expect, test } from 'bun:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createWorkOSSessionProvider } from '../index'

const issuer = 'https://api.workos.com/'
const clientId = 'client_01TEST'

let server: ReturnType<typeof Bun.serve> | null = null

afterEach(() => {
  server?.stop(true)
  server = null
})

async function createSignedToken(
  options: {
    claims?: Record<string, unknown>
    issuer?: string
    expirationTime?: number
  } = {},
) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(publicKey)
  const kid = 'workos-test-key'

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      Response.json({
        keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }],
      }),
  })

  const payload = {
    sub: 'user_01TEST',
    client_id: clientId,
    ...options.claims,
  }

  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(options.issuer ?? issuer)
    .setIssuedAt(1_700_000_000)
    .setExpirationTime(options.expirationTime ?? 2_000_000_000)
    .sign(privateKey)

  return {
    token,
    jwksUrl: `http://127.0.0.1:${server.port}/jwks`,
  }
}

describe('createWorkOSSessionProvider', () => {
  test('returns a provider-neutral session for a valid WorkOS access token', async () => {
    const { token, jwksUrl } = await createSignedToken()
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    const session = await provider.getSession(
      new Request('https://app.example.test/api', {
        headers: { authorization: `Bearer ${token}` },
      }),
    )

    expect(session).toEqual({
      identity: { subject: 'user_01TEST' },
      expiresAt: new Date(2_000_000_000 * 1_000),
    })
  })

  test('rejects tokens issued for another WorkOS application', async () => {
    const { token, jwksUrl } = await createSignedToken({
      claims: { client_id: 'client_01OTHER' },
    })
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.toBeNull()
  })

  test('rejects tokens from another issuer', async () => {
    const { token, jwksUrl } = await createSignedToken({
      issuer: 'https://other.example.test/',
    })
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.toBeNull()
  })

  test('rejects expired tokens and tokens without a subject', async () => {
    const expired = await createSignedToken({ expirationTime: 1 })
    const expiredProvider = createWorkOSSessionProvider({
      jwksUrl: expired.jwksUrl,
      clientId,
      issuer,
    })

    await expect(
      expiredProvider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${expired.token}` },
        }),
      ),
    ).resolves.toBeNull()

    server?.stop(true)
    server = null

    const subjectless = await createSignedToken({ claims: { sub: undefined } })
    const subjectlessProvider = createWorkOSSessionProvider({
      jwksUrl: subjectless.jwksUrl,
      clientId,
      issuer,
    })

    await expect(
      subjectlessProvider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${subjectless.token}` },
        }),
      ),
    ).resolves.toBeNull()
  })

  test('accepts bearer credentials only, never URL query credentials', async () => {
    const { token, jwksUrl } = await createSignedToken()
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request(`https://app.example.test/api?token=${encodeURIComponent(token)}`),
      ),
    ).resolves.toBeNull()
  })

  test('fails closed for a malformed bearer token', async () => {
    const { jwksUrl } = await createSignedToken()
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: 'Bearer not-a-jwt' },
        }),
      ),
    ).resolves.toBeNull()
  })
})
