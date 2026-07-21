import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import {
  createBearerSessionProvider,
  IdentityProviderUnavailableError,
  representableExpiry,
  requireClockSkewInMs,
  requireNonBlank,
  requireSecureJwksUrl,
  type SessionProvider,
} from '@wystack/identity'

export interface WorkOSSessionProviderOptions {
  /**
   * WorkOS JSON Web Key Set endpoint. Defaults to
   * `https://api.workos.com/sso/jwks/<clientId>`.
   *
   * Override only to change the *host* — a custom auth domain, or a fixture server in
   * tests. The path must be exactly `/sso/jwks/<clientId>` — not merely end in it — and
   * that is enforced at
   * construction: the path is the client binding (see `clientId`), so an override
   * naming a different client would accept another application's tokens while every
   * other setting still looked correct. Restricting the override to the host is what
   * keeps the binding true in *every* supported configuration rather than only in the
   * derived one.
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
 * Rejects a `jwksUrl` override whose path does not name `clientId`.
 *
 * The override exists so a deployment can point at a custom AuthKit domain, or a test at
 * a local fixture — that is a *host* substitution. Allowing the path to vary too would
 * undo the derivation above: `clientId` would become decorative, and the provider would
 * accept tokens minted for whichever application the URL actually names. Nothing else
 * would look wrong, because those tokens are genuine and correctly signed.
 *
 * Compared against the encoded form, since that is what the derived URL produces, so the
 * two configurations accept exactly the same set of endpoints.
 */
function requireClientPath(clientId: string, value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('jwksUrl must be an absolute URL')
  }

  const expected = `/sso/jwks/${encodeURIComponent(clientId)}`
  if (url.pathname !== expected) {
    throw new TypeError(
      `jwksUrl path must be ${expected} to stay bound to clientId (got ${url.pathname}); override the host only`,
    )
  }
  return value
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
  // tokens. Deriving makes that inconsistency unrepresentable — but only if the
  // override is constrained too, which is why `requireClientPath` runs on it. A free-form
  // override would reintroduce exactly the mismatch this derivation exists to remove,
  // and the resulting misconfiguration is invisible: every other setting is correct, and
  // tokens from the wrong application verify cleanly.
  //
  // Two independent guards, both applied to the *effective* URL: `requireClientPath`
  // keeps it bound to this client, `requireSecureJwksUrl` keeps it off an interceptable
  // channel. Neither implies the other — `https://api.workos.com/sso/jwks/someone-else`
  // is secure and wrong, `http://host/sso/jwks/<clientId>` is correct and interceptable.
  const jwksUrl = requireSecureJwksUrl(
    'jwksUrl',
    options.jwksUrl === undefined
      ? `https://api.workos.com/sso/jwks/${encodeURIComponent(clientId)}`
      : requireClientPath(clientId, requireNonBlank('jwksUrl', options.jwksUrl)),
  )

  const clockSkewInMs = requireClockSkewInMs(options.clockSkewInMs)

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

        const expiresAt = representableExpiry(payload.exp)
        if (expiresAt === null) return null

        return {
          identity: { subject: payload.sub },
          expiresAt,
        }
      } catch (error) {
        // Re-raise infrastructure faults as a seam-level type so callers can tell an
        // upstream outage from a rejected credential without importing jose and
        // reimplementing this classification. Without it the distinction is drawn
        // correctly here and then lost by every consumer.
        if (isJwksInfrastructureError(error)) {
          throw new IdentityProviderUnavailableError(
            'WorkOS key set could not be retrieved or used',
            { cause: error },
          )
        }

        // Any other jose error is the token failing verification — a rejected
        // credential, which the interface expresses as `null`.
        if (error instanceof errors.JOSEError) return null

        // Anything else is a defect in this closure, not a statement about the token or
        // about WorkOS. Rethrown unchanged so it surfaces as a server fault: labelling
        // it as provider-unavailable would make callers answer 503 and mark it
        // retryable, so clients would keep retrying a deterministic bug that never
        // clears.
        throw error
      }
    },
  })
}
