import { afterEach, describe, expect, test } from 'bun:test'
import { errors, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { createClerkSessionProvider } from '../index'

const origin = 'https://app.example.test'

let server: ReturnType<typeof Bun.serve> | null = null

function stopServer() {
  server?.stop(true)
  server = null
}

afterEach(stopServer)

function authorized(token: string) {
  return new Request('https://app.example.test/api', {
    headers: { authorization: `Bearer ${token}` },
  })
}

async function createSignedToken(
  options: {
    claims?: Record<string, unknown>
    issuer?: string
    algorithm?: 'RS256' | 'PS256'
    expirationTime?: number
    includeExpiration?: boolean
    jwksStatus?: number
    jwksBody?: unknown
    unsupportedCriticalHeader?: boolean
  } = {},
) {
  const algorithm = options.algorithm ?? 'RS256'
  const { publicKey, privateKey } = await generateKeyPair(algorithm)
  const publicJwk = await exportJWK(publicKey)
  const kid = 'clerk-test-key'
  const requestedPaths: string[] = []

  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      requestedPaths.push(new URL(request.url).pathname)
      if (options.jwksStatus) return new Response(null, { status: options.jwksStatus })
      if (options.jwksBody !== undefined) return Response.json(options.jwksBody)
      return Response.json({
        keys: [{ ...publicJwk, kid, alg: algorithm, use: 'sig' }],
      })
    },
  })

  // Clerk derives its key set from the Frontend API issuer, so the test issuer is
  // the local key server itself. That lets the default-URL derivation be observed
  // through the paths the provider actually requests.
  const issuer = `http://127.0.0.1:${server.port}`

  const payload = {
    sub: 'user_01TEST',
    sid: 'sess_01TEST',
    azp: origin,
    ...options.claims,
  }

  const expirationTime = options.expirationTime ?? Math.floor(Date.now() / 1_000) + 3_600

  const protectedHeader = options.unsupportedCriticalHeader
    ? { alg: algorithm, kid, crit: ['unsupported'], unsupported: true }
    : { alg: algorithm, kid }

  let jwt = new SignJWT(payload)
    .setProtectedHeader(protectedHeader)
    .setIssuer(options.issuer ?? issuer)
    .setIssuedAt()

  if (options.includeExpiration !== false) jwt = jwt.setExpirationTime(expirationTime)

  const token = await jwt.sign(
    privateKey,
    options.unsupportedCriticalHeader ? { crit: { unsupported: true } } : undefined,
  )

  return { token, issuer, expirationTime, requestedPaths }
}

describe('createClerkSessionProvider', () => {
  test('rejects blank security configuration at construction', () => {
    expect(() => createClerkSessionProvider({ issuer: ' ' })).toThrow('issuer must not be blank')
    expect(() => createClerkSessionProvider({ issuer: '' })).toThrow(TypeError)
    expect(() =>
      createClerkSessionProvider({ issuer: 'https://clerk.example.test', jwksUrl: ' ' }),
    ).toThrow('jwksUrl must not be blank')
    expect(() =>
      createClerkSessionProvider({
        issuer: 'https://clerk.example.test',
        authorizedParties: [' '],
      }),
    ).toThrow('authorizedParties[0] must not be blank')
  })

  test('returns a provider-neutral session for a valid Clerk session token', async () => {
    const { token, issuer, expirationTime, requestedPaths } = await createSignedToken()
    const provider = createClerkSessionProvider({ issuer, authorizedParties: [origin] })

    const session = await provider.getSession(authorized(token))

    expect(session).toEqual({
      identity: { subject: 'user_01TEST' },
      expiresAt: new Date(expirationTime * 1_000),
    })
    expect(requestedPaths).toEqual(['/.well-known/jwks.json'])
  })

  test('derives the default key set URL without doubling a trailing slash', async () => {
    const { token, issuer, requestedPaths } = await createSignedToken()
    const provider = createClerkSessionProvider({ issuer: `${issuer}///` })

    await expect(provider.getSession(authorized(token))).resolves.not.toBeNull()
    expect(requestedPaths).toEqual(['/.well-known/jwks.json'])
  })

  test('uses an explicitly configured key set URL', async () => {
    const { token, issuer, requestedPaths } = await createSignedToken()
    const provider = createClerkSessionProvider({ issuer, jwksUrl: `${issuer}/custom/jwks.json` })

    await expect(provider.getSession(authorized(token))).resolves.not.toBeNull()
    expect(requestedPaths).toEqual(['/custom/jwks.json'])
  })

  test('rejects tokens from another issuer', async () => {
    const { token, issuer } = await createSignedToken({ issuer: 'https://other.example.test' })
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('rejects tokens whose azp is outside the authorized origins', async () => {
    const { token, issuer } = await createSignedToken({ claims: { azp: 'https://evil.example' } })
    const provider = createClerkSessionProvider({ issuer, authorizedParties: [origin] })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('accepts any authorized origin in the allowlist', async () => {
    const { token, issuer } = await createSignedToken({ claims: { azp: 'https://alt.example' } })
    const provider = createClerkSessionProvider({
      issuer,
      authorizedParties: [origin, 'https://alt.example'],
    })

    await expect(provider.getSession(authorized(token))).resolves.not.toBeNull()
  })

  test('rejects a missing or non-string azp when origins are configured', async () => {
    const missing = await createSignedToken({ claims: { azp: undefined } })
    const missingProvider = createClerkSessionProvider({
      issuer: missing.issuer,
      authorizedParties: [origin],
    })

    await expect(missingProvider.getSession(authorized(missing.token))).resolves.toBeNull()

    stopServer()

    const nonString = await createSignedToken({ claims: { azp: 123 } })
    const nonStringProvider = createClerkSessionProvider({
      issuer: nonString.issuer,
      authorizedParties: [origin],
    })

    await expect(nonStringProvider.getSession(authorized(nonString.token))).resolves.toBeNull()
  })

  test('ignores azp when no authorized origins are configured', async () => {
    const { token, issuer } = await createSignedToken({ claims: { azp: 'https://evil.example' } })
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.not.toBeNull()

    stopServer()

    const missing = await createSignedToken({ claims: { azp: undefined } })
    const emptyListProvider = createClerkSessionProvider({
      issuer: missing.issuer,
      authorizedParties: [],
    })

    await expect(emptyListProvider.getSession(authorized(missing.token))).resolves.not.toBeNull()
  })

  test('rejects expired tokens and tokens without required claims', async () => {
    const expired = await createSignedToken({ expirationTime: 1 })
    const expiredProvider = createClerkSessionProvider({ issuer: expired.issuer })

    await expect(expiredProvider.getSession(authorized(expired.token))).resolves.toBeNull()

    stopServer()

    const expirationless = await createSignedToken({ includeExpiration: false })
    const expirationlessProvider = createClerkSessionProvider({ issuer: expirationless.issuer })

    await expect(
      expirationlessProvider.getSession(authorized(expirationless.token)),
    ).resolves.toBeNull()

    stopServer()

    const subjectless = await createSignedToken({ claims: { sub: undefined } })
    const subjectlessProvider = createClerkSessionProvider({ issuer: subjectless.issuer })

    await expect(subjectlessProvider.getSession(authorized(subjectless.token))).resolves.toBeNull()
  })

  test('rejects a non-numeric expiration', async () => {
    // jose rejects a non-numeric `exp` during claim validation, so this never reaches
    // the provider's own type guard — verified by removing that guard and watching this
    // still pass. The test pins the contract, not the mechanism: whichever layer enforces
    // it, a string `exp` must resolve null rather than an Invalid Date expiry.
    const { token, issuer } = await createSignedToken({
      claims: { exp: 'not-a-number' },
      includeExpiration: false,
    })
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('rejects a custom JWT template token that carries no session id', async () => {
    // Clerk signs custom JWT templates with the same key and issuer as session tokens
    // and gives them `sub`, `exp`, and `azp` — but not `sid`, because they are not bound
    // to a session. Accepting one would let a token minted for another service log in.
    const { token, issuer } = await createSignedToken({ claims: { sid: undefined } })
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('rejects a non-string or empty session id', async () => {
    const nonString = await createSignedToken({ claims: { sid: 123 } })
    const nonStringProvider = createClerkSessionProvider({ issuer: nonString.issuer })

    await expect(nonStringProvider.getSession(authorized(nonString.token))).resolves.toBeNull()

    stopServer()

    const empty = await createSignedToken({ claims: { sid: '' } })
    const emptyProvider = createClerkSessionProvider({ issuer: empty.issuer })

    await expect(emptyProvider.getSession(authorized(empty.token))).resolves.toBeNull()
  })

  test('rejects a non-string or empty subject', async () => {
    const nonString = await createSignedToken({ claims: { sub: 123 } })
    const nonStringProvider = createClerkSessionProvider({ issuer: nonString.issuer })

    await expect(nonStringProvider.getSession(authorized(nonString.token))).resolves.toBeNull()

    stopServer()

    const empty = await createSignedToken({ claims: { sub: '' } })
    const emptyProvider = createClerkSessionProvider({ issuer: empty.issuer })

    await expect(emptyProvider.getSession(authorized(empty.token))).resolves.toBeNull()
  })

  test('accepts bearer credentials only, never URL query credentials', async () => {
    const { token, issuer } = await createSignedToken()
    const provider = createClerkSessionProvider({ issuer })

    await expect(
      provider.getSession(
        new Request(`https://app.example.test/api?token=${encodeURIComponent(token)}`),
      ),
    ).resolves.toBeNull()
  })

  test('fails closed for a malformed bearer token', async () => {
    const { issuer } = await createSignedToken()
    const provider = createClerkSessionProvider({ issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: 'Bearer not-a-jwt' },
        }),
      ),
    ).resolves.toBeNull()
  })

  test('fails closed for a token signed with an algorithm other than RS256', async () => {
    const { token, issuer } = await createSignedToken({ algorithm: 'PS256' })
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('fails closed for an unsupported critical JWT header', async () => {
    const { token, issuer } = await createSignedToken({ unsupportedCriticalHeader: true })
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('fails closed when the key set no longer carries the signing key', async () => {
    const { token, issuer } = await createSignedToken({ jwksBody: { keys: [] } })
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('surfaces JWKS infrastructure failures', async () => {
    const { token, issuer } = await createSignedToken({ jwksStatus: 503 })
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).rejects.toBeInstanceOf(errors.JOSEError)
  })

  test('surfaces a malformed key set as an infrastructure failure', async () => {
    const { token, issuer } = await createSignedToken({ jwksBody: { not: 'a key set' } })
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).rejects.toBeInstanceOf(errors.JWKSInvalid)
  })

  test('surfaces an unreachable key server rather than denying the credential', async () => {
    const { token, issuer } = await createSignedToken()
    stopServer()
    const provider = createClerkSessionProvider({ issuer })

    await expect(provider.getSession(authorized(token))).rejects.toThrow()
  })
})
