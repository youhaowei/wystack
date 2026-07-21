import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { createBearerSessionProvider, type SessionProvider } from '@wystack/identity'

export interface WorkOSSessionProviderOptions {
  /**
   * WorkOS JSON Web Key Set endpoint. Defaults to
   * `https://api.workos.com/sso/jwks/<clientId>`.
   *
   * Override only for a custom auth domain. The path is client-specific, and that is
   * what binds a token to this application — see `clientId`.
   */
  jwksUrl?: string
  /**
   * WorkOS application client ID.
   *
   * This is the client binding, and it binds through the *key set* rather than through
   * a claim. WorkOS serves a distinct JWKS per client at `/sso/jwks/<clientId>`, so a
   * token that verifies against this client's keys was issued for this client by
   * construction. There is no claim to compare: WorkOS's documented access-token claims
   * are `sub`, `sid`, `iss`, `org_id`, `role`, `permissions`, `exp`, and `iat` — no
   * `client_id`, and no `aud` or `azp` either.
   */
  clientId: string
  /** Expected token issuer, including a configured custom AuthKit domain. */
  issuer: string
  /**
   * Permitted clock difference against `exp` and `nbf`, in milliseconds. Defaults to
   * 5000 ms.
   *
   * `iat` is deliberately not covered. jose's `clockTolerance` only participates in
   * `iat` validation when `maxTokenAge` is set, which this verifier does not set, and
   * there is no separate future-`iat` check — so a token with an arbitrarily future
   * `iat` is accepted. That is not a forgery path (the signature and `exp` still bind),
   * but naming `iat` here would promise a check that does not exist.
   *
   * jose allows none, so an application server a few seconds ahead of WorkOS rejects
   * tokens the moment they are minted — and the failure scales with drift rather than
   * appearing at a threshold, so it reads as intermittent auth flakiness rather than as
   * a clock problem. Servers drift; the token does not have to be near expiry for this
   * to bite.
   *
   * Named to match `identity-clerk`, whose spelling comes from Clerk's own
   * `clockSkewInMs` middleware option. WorkOS publishes no corresponding default, so
   * the 5000 ms value is the sibling adapter's rather than a vendor recommendation.
   */
  clockSkewInMs?: number
}

/**
 * Returns the trimmed value, rejecting one that is blank.
 *
 * Trimming rather than preserving the input, because every option here is a copy-paste
 * from a dashboard and surrounding whitespace is never meaningful in any of them. It is
 * also not harmless: `clientId` is percent-encoded into the JWKS path, so a trailing
 * newline derives `.../client_01ABC%0A`, which 404s. The resulting failure is a key-set
 * error on every single verification — an outage that reads as a WorkOS problem rather
 * than as a typo in configuration. `issuer` fails the same way, silently, by never
 * matching the `iss` claim.
 *
 * Validating on the trimmed form while returning the raw one would be the worst of both:
 * the check passes, then the untrimmed value is used anyway.
 */
function requireNonBlank(name: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new TypeError(`${name} must not be blank`)
  return trimmed
}

function isJwksInfrastructureError(error: unknown): boolean {
  return (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error instanceof errors.JWKInvalid ||
    (error instanceof errors.JOSEError && error.constructor === errors.JOSEError)
  )
}

/**
 * Verifies WorkOS bearer access tokens and normalizes them to the provider-neutral
 * identity session interface. Interactive login and application authorization stay
 * with the consuming application.
 */
export function createWorkOSSessionProvider(
  options: WorkOSSessionProviderOptions,
): SessionProvider {
  const clientId = requireNonBlank('clientId', options.clientId)
  const issuer = requireNonBlank('issuer', options.issuer)
  // Derived from `clientId` rather than required separately, because the two are not
  // independent: the JWKS path *is* the client binding, so a `jwksUrl` naming a
  // different client than `clientId` would silently accept another application's
  // tokens. Deriving makes that inconsistency unrepresentable in the common case.
  const jwksUrl =
    options.jwksUrl === undefined
      ? `https://api.workos.com/sso/jwks/${encodeURIComponent(clientId)}`
      : requireNonBlank('jwksUrl', options.jwksUrl)

  // Validated at construction rather than trusted, because the failure is silent and
  // inverted: `clockTolerance: NaN` makes both `exp <= now - NaN` and `nbf > now + NaN`
  // evaluate false, which *disables* the expiry and not-before checks instead of
  // tightening them. A token that expired years ago would verify. A negative value is
  // rejected on the same principle — it narrows the window rather than widening it, so
  // it is far more likely a unit mix-up than an intent.
  const clockSkewInMs = options.clockSkewInMs ?? 5_000
  if (!Number.isFinite(clockSkewInMs) || clockSkewInMs < 0) {
    throw new TypeError('clockSkewInMs must be a non-negative finite number')
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl))

  return createBearerSessionProvider({
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          issuer,
          requiredClaims: ['sub', 'sid', 'exp'],
          // jose reads the numeric form as *seconds*; the option is milliseconds.
          clockTolerance: clockSkewInMs / 1_000,
        })
        // No `client_id` comparison: WorkOS does not put one on access tokens, and the
        // key set already carries the binding. `sid` is required instead — it is
        // documented as present on every access token, and it is what makes this a
        // session credential rather than some other token WorkOS signs.
        if (
          typeof payload.sub !== 'string' ||
          payload.sub.length === 0 ||
          typeof payload.sid !== 'string' ||
          payload.sid.length === 0 ||
          typeof payload.exp !== 'number'
        ) {
          return null
        }

        // `exp` being numeric and unexpired does not make it representable as a Date.
        // `Date`'s ceiling is 8.64e15 ms, so a far-future `exp` overflows into an
        // Invalid Date — which serializes to null and compares false against every
        // other date. The credential would look valid while carrying an expiry no
        // consumer can act on, including any caller that decides re-authentication by
        // comparing against it. Reject it instead.
        const expiresAt = new Date(payload.exp * 1_000)
        if (Number.isNaN(expiresAt.getTime())) return null

        return {
          identity: { subject: payload.sub },
          expiresAt,
        }
      } catch (error) {
        if (error instanceof errors.JOSEError && !isJwksInfrastructureError(error)) return null
        throw error
      }
    },
  })
}
