import { afterEach, describe, expect, test } from 'bun:test'
import { errors, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { IdentityProviderUnavailableError } from '@wystack/identity'
import { type ClerkSessionProviderOptions, createClerkSessionProvider } from '../index'

const origin = 'https://app.example.test'

/**
 * `authorizedParties` is required, so every test that exercises verification has to
 * supply one to reach the behavior it actually covers. Defaulting it here keeps those
 * tests about their own subject; the construction-validation tests call
 * `createClerkSessionProvider` directly so the argument under test stays visible.
 */
function makeProvider(
  options: Omit<ClerkSessionProviderOptions, 'authorizedParties'> &
    Partial<Pick<ClerkSessionProviderOptions, 'authorizedParties'>>,
) {
  return createClerkSessionProvider({ authorizedParties: [origin], ...options })
}

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
    const valid = { authorizedParties: [origin] }

    expect(() => createClerkSessionProvider({ ...valid, issuer: ' ' })).toThrow(
      'issuer must not be blank',
    )
    // Asserting only `TypeError` here would not isolate the blank guard: with it removed,
    // an empty issuer reaches `new URL('/.well-known/jwks.json')`, which throws a
    // TypeError of its own and would keep this green.
    expect(() => createClerkSessionProvider({ ...valid, issuer: '' })).toThrow(
      'issuer must not be blank',
    )
    expect(() =>
      createClerkSessionProvider({ ...valid, issuer: 'https://clerk.example.test', jwksUrl: ' ' }),
    ).toThrow('jwksUrl must not be blank')
    expect(() =>
      createClerkSessionProvider({
        issuer: 'https://clerk.example.test',
        authorizedParties: [' '],
      }),
    ).toThrow('authorizedParties[0] must not be blank')
  })

  test('rejects a JWKS endpoint reachable over plain http', () => {
    // Key retrieval is the root of trust: an attacker who substitutes the key set mints
    // tokens that satisfy every other check — issuer, azp, expiry, subject — because they
    // hold the private half of the key this verifier is told to trust.
    expect(() =>
      createClerkSessionProvider({
        issuer: 'https://clerk.example.test',
        jwksUrl: 'http://clerk.example.test/.well-known/jwks.json',
        authorizedParties: ['https://app.example.test'],
      }),
    ).toThrow('jwksUrl must use https')

    // The derived case matters more than the explicit one, because it is the path nobody
    // configures: with the guard applied only to an explicit `jwksUrl`, an `http://`
    // issuer would sail through and the insecure URL would reach the fetch anyway. The
    // error names `issuer`, since that is the option the operator actually set.
    expect(() =>
      createClerkSessionProvider({
        issuer: 'http://clerk.example.test',
        authorizedParties: ['https://app.example.test'],
      }),
    ).toThrow('issuer must use https')

    // Loopback stays permitted — the fixtures in this file depend on it, so it is pinned
    // rather than left as an accident of the implementation.
    expect(() =>
      createClerkSessionProvider({
        issuer: 'http://127.0.0.1:1234',
        authorizedParties: ['https://app.example.test'],
      }),
    ).not.toThrow()
  })

  test('requires at least one authorized origin at construction', () => {
    // The empty list is the case types cannot catch: omitting the option is a compile
    // error, but `[]` type-checks and would silently restore an unconditional accept.
    expect(() =>
      createClerkSessionProvider({ issuer: 'https://clerk.example.test', authorizedParties: [] }),
    ).toThrow('authorizedParties must list at least one origin')
  })

  test('returns a provider-neutral session for a valid Clerk session token', async () => {
    const { token, issuer, expirationTime, requestedPaths } = await createSignedToken()
    const provider = makeProvider({ issuer, authorizedParties: [origin] })

    const session = await provider.getSession(authorized(token))

    expect(session).toEqual({
      identity: { subject: 'user_01TEST' },
      expiresAt: new Date(expirationTime * 1_000),
    })
    expect(requestedPaths).toEqual(['/.well-known/jwks.json'])
  })

  test('derives the default key set URL without doubling a trailing slash', async () => {
    const { token, issuer, requestedPaths } = await createSignedToken()
    const provider = makeProvider({ issuer: `${issuer}///` })

    await expect(provider.getSession(authorized(token))).resolves.not.toBeNull()
    expect(requestedPaths).toEqual(['/.well-known/jwks.json'])
  })

  test('uses an explicitly configured key set URL', async () => {
    const { token, issuer, requestedPaths } = await createSignedToken()
    const provider = makeProvider({ issuer, jwksUrl: `${issuer}/custom/jwks.json` })

    await expect(provider.getSession(authorized(token))).resolves.not.toBeNull()
    expect(requestedPaths).toEqual(['/custom/jwks.json'])
  })

  test('rejects tokens from another issuer', async () => {
    const { token, issuer } = await createSignedToken({ issuer: 'https://other.example.test' })
    const provider = makeProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('rejects tokens whose azp is outside the authorized origins', async () => {
    const { token, issuer } = await createSignedToken({ claims: { azp: 'https://evil.example' } })
    const provider = makeProvider({ issuer, authorizedParties: [origin] })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('accepts any authorized origin in the allowlist', async () => {
    const { token, issuer } = await createSignedToken({ claims: { azp: 'https://alt.example' } })
    const provider = makeProvider({
      issuer,
      authorizedParties: [origin, 'https://alt.example'],
    })

    await expect(provider.getSession(authorized(token))).resolves.not.toBeNull()
  })

  test('accepts a session token that carries no azp at all', async () => {
    // Clerk documents `azp` as omissible: it echoes the `Origin` header of the
    // originating Frontend API request, and Clerk drops the claim when that header is
    // empty or null. Rejecting here would permanently 401 real users behind sandboxed
    // iframes, some native webviews, and privacy-hardened browsers — and no
    // configuration could accept them, since the allowlist is mandatory. Development
    // never sees it, because dev browsers always send `Origin`.
    //
    // This test previously asserted the opposite. It passed, which is the lesson: a
    // test that encodes the wrong behavior confirms it rather than catching it.
    const { token, issuer } = await createSignedToken({ claims: { azp: undefined } })

    await expect(makeProvider({ issuer }).getSession(authorized(token))).resolves.not.toBeNull()
  })

  test('treats a null azp as absent rather than malformed', async () => {
    // `undefined` disappears during JSON serialization, so the test above never
    // actually puts an `azp` key in the payload. An explicit `null` does survive, and
    // it is the shape a JSON-producing minter is most likely to emit for "no origin".
    // The guard checks both; only `undefined` was pinned.
    const { token, issuer } = await createSignedToken({ claims: { azp: null } })

    await expect(makeProvider({ issuer }).getSession(authorized(token))).resolves.not.toBeNull()
  })

  test('rejects a non-string azp rather than treating it as absent', async () => {
    // The skip above is for an *omitted* claim. A numeric `azp` is malformed, not
    // omitted, so it must not inherit the exemption — guarding on
    // `typeof azp === 'string'` instead of on absence would accept this token.
    const { token, issuer } = await createSignedToken({ claims: { azp: 123 } })

    await expect(makeProvider({ issuer }).getSession(authorized(token))).resolves.toBeNull()
  })

  test('rejects expired tokens and tokens without required claims', async () => {
    const expired = await createSignedToken({ expirationTime: 1 })
    const expiredProvider = makeProvider({ issuer: expired.issuer })

    await expect(expiredProvider.getSession(authorized(expired.token))).resolves.toBeNull()

    stopServer()

    const expirationless = await createSignedToken({ includeExpiration: false })
    const expirationlessProvider = makeProvider({ issuer: expirationless.issuer })

    await expect(
      expirationlessProvider.getSession(authorized(expirationless.token)),
    ).resolves.toBeNull()

    stopServer()

    const subjectless = await createSignedToken({ claims: { sub: undefined } })
    const subjectlessProvider = makeProvider({ issuer: subjectless.issuer })

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
    const provider = makeProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('rejects a custom JWT template token that carries no session id', async () => {
    // Clerk signs custom JWT templates with the same key and issuer as session tokens
    // and gives them `sub`, `exp`, and `azp` — but not `sid`, because they are not bound
    // to a session. Accepting one would let a token minted for another service log in.
    const { token, issuer } = await createSignedToken({ claims: { sid: undefined } })
    const provider = makeProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('rejects a non-string or empty session id', async () => {
    const nonString = await createSignedToken({ claims: { sid: 123 } })
    const nonStringProvider = makeProvider({ issuer: nonString.issuer })

    await expect(nonStringProvider.getSession(authorized(nonString.token))).resolves.toBeNull()

    stopServer()

    const empty = await createSignedToken({ claims: { sid: '' } })
    const emptyProvider = makeProvider({ issuer: empty.issuer })

    await expect(emptyProvider.getSession(authorized(empty.token))).resolves.toBeNull()
  })

  test('tolerates Clerk-sized clock skew by default but not unbounded drift', async () => {
    // Clerk's own middleware allows 5000 ms of skew; jose allows none. A server clock a
    // few seconds fast would otherwise reject sessions Clerk considers valid.
    const justExpired = await createSignedToken({
      expirationTime: Math.floor(Date.now() / 1_000) - 2,
    })
    const tolerant = makeProvider({ issuer: justExpired.issuer })

    await expect(tolerant.getSession(authorized(justExpired.token))).resolves.not.toBeNull()

    stopServer()

    const longExpired = await createSignedToken({
      expirationTime: Math.floor(Date.now() / 1_000) - 60,
    })
    const strict = makeProvider({ issuer: longExpired.issuer })

    await expect(strict.getSession(authorized(longExpired.token))).resolves.toBeNull()
  })

  test('rejects an invalid clock skew at construction', () => {
    expect(() => makeProvider({ issuer: 'https://clerk.example.test', clockSkewInMs: -1 })).toThrow(
      'clockSkewInMs must be a non-negative finite number',
    )
    expect(() =>
      makeProvider({
        issuer: 'https://clerk.example.test',
        clockSkewInMs: Number.NaN,
      }),
    ).toThrow(TypeError)
  })

  test('rejects an expiration outside the representable Date range', async () => {
    // Numeric and unexpired is not the same as representable: `Date`'s ceiling is
    // 8.64e15 ms, so this overflows to an Invalid Date rather than a far-future expiry.
    const { token, issuer } = await createSignedToken({
      claims: { exp: 8_640_000_000_001 },
      includeExpiration: false,
    })
    const provider = makeProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('rejects a non-string or empty subject', async () => {
    const nonString = await createSignedToken({ claims: { sub: 123 } })
    const nonStringProvider = makeProvider({ issuer: nonString.issuer })

    await expect(nonStringProvider.getSession(authorized(nonString.token))).resolves.toBeNull()

    stopServer()

    const empty = await createSignedToken({ claims: { sub: '' } })
    const emptyProvider = makeProvider({ issuer: empty.issuer })

    await expect(emptyProvider.getSession(authorized(empty.token))).resolves.toBeNull()
  })

  test('accepts bearer credentials only, never URL query credentials', async () => {
    const { token, issuer } = await createSignedToken()
    const provider = makeProvider({ issuer })

    await expect(
      provider.getSession(
        new Request(`https://app.example.test/api?token=${encodeURIComponent(token)}`),
      ),
    ).resolves.toBeNull()
  })

  test('fails closed for a malformed bearer token', async () => {
    const { issuer } = await createSignedToken()
    const provider = makeProvider({ issuer })

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
    const provider = makeProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('fails closed for an unsupported critical JWT header', async () => {
    const { token, issuer } = await createSignedToken({ unsupportedCriticalHeader: true })
    const provider = makeProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('fails closed when the key set no longer carries the signing key', async () => {
    const { token, issuer } = await createSignedToken({ jwksBody: { keys: [] } })
    const provider = makeProvider({ issuer })

    await expect(provider.getSession(authorized(token))).resolves.toBeNull()
  })

  test('trims configuration rather than validating a trimmed copy', async () => {
    // Every option here is a copy-paste from the Clerk dashboard, so a trailing newline
    // is a realistic input. It has to be dropped, not merely tolerated by the blank
    // check: `normalizeIssuer` strips trailing slashes but not whitespace, so a padded
    // `issuer` reaches `jwtVerify` unmodified and never matches a real token's `iss`.
    // Every request then 401s with nothing pointing at the whitespace. Verifying a real
    // token with padded configuration is what proves the trimmed value is the one used.
    const { token, issuer } = await createSignedToken()
    const provider = makeProvider({ issuer: `  ${issuer}\n` })

    await expect(provider.getSession(authorized(token))).resolves.not.toBeNull()
  })

  test('surfaces JWKS infrastructure failures as a seam-level fault', async () => {
    const { token, issuer } = await createSignedToken({ jwksStatus: 503 })
    const provider = makeProvider({ issuer })

    const error = await provider.getSession(authorized(token)).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(IdentityProviderUnavailableError)
    // Wrapping must not destroy the diagnosis. The seam-level type tells the caller how
    // to respond; `cause` tells an operator what actually broke.
    expect((error as Error).cause).toBeInstanceOf(errors.JOSEError)
  })

  test('surfaces a malformed key set as an infrastructure failure', async () => {
    const { token, issuer } = await createSignedToken({ jwksBody: { not: 'a key set' } })
    const provider = makeProvider({ issuer })

    const error = await provider.getSession(authorized(token)).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(IdentityProviderUnavailableError)
    expect((error as Error).cause).toBeInstanceOf(errors.JWKSInvalid)
  })

  test('surfaces an unreachable key server rather than denying the credential', async () => {
    // The 503 case above is the *forgiving* outage: the key server is healthy enough to
    // answer, so jose produces a `JOSEError` that can be classified after the fact. The
    // common shapes are not — connection refused, DNS failure, TLS failure and network
    // partition are rethrown as whatever the platform's `fetch` produced, with nothing
    // marking them as ours. Without a test at this shape, the suite passes while every
    // real outage answers 401.
    const { token, issuer } = await createSignedToken()
    stopServer()
    const provider = makeProvider({ issuer })

    const error = await provider.getSession(authorized(token)).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(IdentityProviderUnavailableError)
    // The message, not only the class: if this port were reused by anything answering
    // non-200, jose would raise its base `JOSEError` and the post-hoc branch would wrap
    // it into the *same* class — so a class-only assertion would pass while exercising
    // the old path instead of the new one. The message pins the `customFetch` site.
    expect((error as Error).message).toContain('could not be reached')
  })
})
