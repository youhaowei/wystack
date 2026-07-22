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
    unsupportedCriticalHeader?: boolean
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

  // Modelled on WorkOS's documented access-token claims: `sub`, `sid`, `iss`, `exp`,
  // `iat`, plus the conditional `org_id`/`role`/`permissions`. Notably there is no
  // `client_id` — an earlier version of this fixture invented one, which made every
  // test agree with every other test and none of them with WorkOS.
  const payload = {
    sub: 'user_01TEST',
    sid: 'session_01TEST',
    ...options.claims,
  }

  const expirationTime = options.expirationTime ?? Math.floor(Date.now() / 1_000) + 3_600

  const protectedHeader = options.unsupportedCriticalHeader
    ? { alg: 'RS256', kid, crit: ['unsupported'], unsupported: true }
    : { alg: 'RS256', kid }

  let jwt = new SignJWT(payload)
    .setProtectedHeader(protectedHeader)
    .setIssuer(options.issuer ?? issuer)
    .setIssuedAt()

  if (options.includeExpiration !== false) jwt = jwt.setExpirationTime(expirationTime)

  const token = await jwt.sign(
    privateKey,
    options.unsupportedCriticalHeader ? { crit: { unsupported: true } } : undefined,
  )

  return {
    token,
    // Client-specific path, matching what WorkOS serves and what the provider derives.
    // A fixture at a bare `/jwks` would exercise a configuration the provider no longer
    // accepts, and would hide the binding check from every test that uses it.
    jwksUrl: `http://127.0.0.1:${server.port}/sso/jwks/${encodeURIComponent(clientId)}`,
    expirationTime,
  }
}

describe('createWorkOSSessionProvider', () => {
  test('rejects blank security configuration at construction', () => {
    const base = { jwksUrl: `https://api.workos.com/sso/jwks/${clientId}`, clientId, issuer }

    expect(() => createWorkOSSessionProvider({ ...base, issuer: ' ' })).toThrow(
      'issuer must not be blank',
    )
    expect(() => createWorkOSSessionProvider({ ...base, clientId: ' ' })).toThrow(
      'clientId must not be blank',
    )
    expect(() => createWorkOSSessionProvider({ ...base, jwksUrl: ' ' })).toThrow(
      'jwksUrl must not be blank',
    )
  })

  test('trims configuration rather than validating a trimmed copy', async () => {
    // Every option here is a copy-paste from a dashboard, so a trailing newline is a
    // realistic input. It has to be dropped, not merely tolerated by the blank check:
    // an untrimmed `issuer` never matches the `iss` claim, and an untrimmed `clientId`
    // is percent-encoded into the JWKS path as `%0A` and 404s. Verifying a real token
    // with padded configuration is what proves the trimmed value is the one used.
    const { token, jwksUrl } = await createSignedToken()
    const provider = createWorkOSSessionProvider({
      jwksUrl,
      clientId: `  ${clientId}\n`,
      issuer: `  ${issuer}\n`,
    })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.not.toBeNull()
  })

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

  test('rejects a non-loopback http JWKS URL at construction', () => {
    // Key retrieval is the root of trust: an attacker who can substitute the key set
    // mints tokens that satisfy every other check, because they hold the private half
    // of the key this verifier is told to trust.
    // Client-correct path throughout, so this isolates the transport guard rather than
    // tripping the client-binding guard first and passing for the wrong reason.
    expect(() =>
      createWorkOSSessionProvider({
        jwksUrl: `http://api.workos.com/sso/jwks/${clientId}`,
        clientId,
        issuer,
      }),
    ).toThrow('jwksUrl must use https')

    // Loopback stays permitted — this is the exemption the fixtures rely on, so it is
    // pinned rather than left as an accident of the implementation.
    expect(() =>
      createWorkOSSessionProvider({
        jwksUrl: `http://127.0.0.1:1234/sso/jwks/${clientId}`,
        clientId,
        issuer,
      }),
    ).not.toThrow()

    // A private-range address is not loopback: it is still a network hop someone can
    // sit on, which is the threat being closed.
    expect(() =>
      createWorkOSSessionProvider({
        jwksUrl: `http://10.0.0.5/sso/jwks/${clientId}`,
        clientId,
        issuer,
      }),
    ).toThrow('jwksUrl must use https')
  })

  test('derives the client-specific JWKS URL from clientId', () => {
    // The JWKS path is the client binding, so `clientId` has to reach it. Previously
    // `jwksUrl` was required separately and `clientId` was only compared against a
    // claim, which meant the two could name different applications with nothing
    // catching it.
    expect(() => createWorkOSSessionProvider({ clientId, issuer })).not.toThrow()
  })

  test('rejects a jwksUrl whose path names a different client', async () => {
    // The whole point of the derivation is that `clientId` reaches the key set. A
    // free-form override undoes it: the provider would fetch another application's keys,
    // and that application's genuine, correctly signed tokens would verify. Nothing else
    // in the configuration would look wrong.
    const { jwksUrl } = await createSignedToken()
    const other = jwksUrl.replace(clientId, 'client_01OTHER')

    expect(() => createWorkOSSessionProvider({ jwksUrl: other, clientId, issuer })).toThrow(
      'jwksUrl path must be /sso/jwks/client_01TEST',
    )
  })

  test('accepts a host-only jwksUrl override for a custom auth domain', async () => {
    // The override has to keep working for a custom AuthKit domain — the guard is meant
    // to constrain the path, not to remove the option. Without this case, deleting the
    // override entirely would leave the suite green.
    const { token, jwksUrl } = await createSignedToken()
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.not.toBeNull()
  })

  test('rejects a non-string sid', async () => {
    // `requiredClaims` only asserts presence, so it accepts `sid: 123`. The type guard
    // in the verifier is the half that rejects it — without this case, removing that
    // guard leaves the suite green.
    const { token, jwksUrl } = await createSignedToken({ claims: { sid: 123 } })
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.toBeNull()
  })

  test('rejects a token with no sid', async () => {
    // WorkOS documents `sid` on every access token; it is what makes this a session
    // credential. Requiring it replaces the old `client_id` equality check, which
    // required a claim WorkOS does not issue.
    const { token, jwksUrl } = await createSignedToken({ claims: { sid: undefined } })
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

  test('fails closed for an unsupported critical JWT header', async () => {
    const { token, jwksUrl } = await createSignedToken({ unsupportedCriticalHeader: true })
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
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

  test('rejects an exp that is unexpired but not representable as a Date', async () => {
    // Passes `requiredClaims`, passes the `typeof === 'number'` check, and is not
    // expired — but `new Date(exp * 1000)` overflows `Date`'s 8.64e15 ms ceiling.
    // Returning it would hand the caller a session whose `expiresAt` is an Invalid
    // Date: it serializes to null and compares false against every other date, so a
    // caller deciding re-authentication by comparison never re-authenticates.
    const { token, jwksUrl } = await createSignedToken({ expirationTime: 8.64e15 })
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.toBeNull()
  })

  test('tolerates a server clock ahead of the token by less than the skew allowance', async () => {
    // The real shape of this failure is a freshly minted token, not a nearly-expired
    // one: with zero tolerance an application server a few seconds fast rejects tokens
    // WorkOS considers valid, and the rejection scales with drift rather than with how
    // close `exp` is. Modelled here by an `exp` a second in the past, which stands in
    // for a server one second ahead.
    const { token, jwksUrl } = await createSignedToken({
      expirationTime: Math.floor(Date.now() / 1_000) - 1,
    })
    const provider = createWorkOSSessionProvider({ jwksUrl, clientId, issuer })

    await expect(
      provider.getSession(
        new Request('https://app.example.test/api', {
          headers: { authorization: `Bearer ${token}` },
        }),
      ),
    ).resolves.not.toBeNull()
  })

  test('still rejects tokens expired beyond the skew allowance', async () => {
    // The allowance widens the window; it must not remove it. Without this the test
    // above could be satisfied by disabling the expiry check entirely.
    const { token, jwksUrl } = await createSignedToken({
      expirationTime: Math.floor(Date.now() / 1_000) - 60,
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

  test('rejects a non-finite or negative clock skew at construction', () => {
    // `NaN` is the case that matters, and it fails *open*: jose compares
    // `exp <= now - tolerance`, and every comparison against NaN is false, so both the
    // expiry and not-before checks stop rejecting anything. A token that expired in
    // 1970 would verify. Asserting the throw is what keeps that unreachable.
    const base = { jwksUrl: `https://api.workos.com/sso/jwks/${clientId}`, clientId, issuer }

    for (const clockSkewInMs of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => createWorkOSSessionProvider({ ...base, clockSkewInMs })).toThrow(
        'clockSkewInMs must be a non-negative finite number',
      )
    }
  })
})
