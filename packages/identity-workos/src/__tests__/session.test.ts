import { afterEach, describe, expect, test } from 'bun:test'
import { errors, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createWorkOSSessionProvider } from '../index'

const issuer = 'https://api.workos.com/'
const clientId = 'client_01TEST'

let server: ReturnType<typeof Bun.serve> | null = null

function stopServer() {
  server?.stop(true)
  server = null
}

afterEach(stopServer)

async function createSignedToken(
  options: {
    claims?: Record<string, unknown>
    issuer?: string
    expirationTime?: number
    includeExpiration?: boolean
    jwksStatus?: number
  } = {},
) {
  const { publicKey, privateKey } = await generateKeyPair('RS256')
  const publicJwk = await exportJWK(publicKey)
  const kid = 'workos-test-key'

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => {
      if (options.jwksStatus) return new Response(null, { status: options.jwksStatus })
      return Response.json({
        keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }],
      })
    },
  })

  const payload = {
    sub: 'user_01TEST',
    client_id: clientId,
    ...options.claims,
  }

  const expirationTime = options.expirationTime ?? Math.floor(Date.now() / 1_000) + 3_600

  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(options.issuer ?? issuer)
    .setIssuedAt()

  if (options.includeExpiration !== false) jwt = jwt.setExpirationTime(expirationTime)

  const token = await jwt.sign(privateKey)

  return {
    token,
    jwksUrl: `http://127.0.0.1:${server.port}/jwks`,
    expirationTime,
  }
}

describe('createWorkOSSessionProvider', () => {
  test('returns a provider-neutral session for a valid WorkOS access token', async () => {
    const { token, jwksUrl, expirationTime } = await createSignedToken()
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    const session = await provider.getSession(
      new Request('https://app.example.test/api', {
        headers: { authorization: `Bearer ${token}` },
      }),
    )

    expect(session).toEqual({
      identity: { subject: 'user_01TEST' },
      expiresAt: new Date(expirationTime * 1_000),
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

  test('rejects expired tokens and tokens without required claims', async () => {
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

    stopServer()

    const expirationless = await createSignedToken({ includeExpiration: false })
    const expirationlessProvider = createWorkOSSessionProvider({
      jwksUrl: expirationless.jwksUrl,
      clientId,
      issuer,
    })

    await expect(
      expirationlessProvider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${expirationless.token}` },
        }),
      ),
    ).resolves.toBeNull()

    stopServer()

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

  test('rejects a non-string subject', async () => {
    const { token, jwksUrl } = await createSignedToken({ claims: { sub: 123 } })
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
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

  test('surfaces JWKS infrastructure failures', async () => {
    const { token, jwksUrl } = await createSignedToken({ jwksStatus: 503 })
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).rejects.toBeInstanceOf(errors.JOSEError)
  })
})
