import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { createBearerSessionProvider, type SessionProvider } from '@wystack/identity'

export interface WorkOSSessionProviderOptions {
  /** Client-specific WorkOS JSON Web Key Set endpoint. */
  jwksUrl: string
  /** WorkOS application client ID expected in the access token. */
  clientId: string
  /** Expected token issuer, including a configured custom AuthKit domain. */
  issuer: string
  /**
   * Permitted clock difference against `exp`, `nbf`, and `iat`, in milliseconds.
   * Defaults to 5000 ms.
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

function requireNonBlank(name: string, value: string): string {
  if (value.trim().length === 0) throw new TypeError(`${name} must not be blank`)
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
  const jwks = createRemoteJWKSet(new URL(requireNonBlank('jwksUrl', options.jwksUrl)))
  const clientId = requireNonBlank('clientId', options.clientId)
  const issuer = requireNonBlank('issuer', options.issuer)

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

  return createBearerSessionProvider({
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          issuer,
          requiredClaims: ['sub', 'client_id', 'exp'],
          // jose reads the numeric form as *seconds*; the option is milliseconds.
          clockTolerance: clockSkewInMs / 1_000,
        })
        if (
          typeof payload.sub !== 'string' ||
          payload.sub.length === 0 ||
          payload.client_id !== clientId ||
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
