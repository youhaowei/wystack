import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { createBearerSessionProvider, type SessionProvider } from '@wystack/identity'

export interface ClerkSessionProviderOptions {
  /** Clerk Frontend API issuer, e.g. `https://<slug>.clerk.accounts.dev`. */
  issuer: string
  /** JSON Web Key Set endpoint. Defaults to `<issuer>/.well-known/jwks.json`. */
  jwksUrl?: string
  /**
   * Origins permitted in Clerk's `azp` claim. Clerk sets `azp` to the requesting
   * origin rather than a client identifier, so this is an allowlist rather than a
   * single expected value.
   *
   * Required, and must list at least one origin. An optional origin check would
   * default to off, which is the wrong default for a security control and would
   * make this adapter weaker than `identity-workos`, where the corresponding
   * `clientId` is mandatory. A deployment that genuinely cannot enumerate its
   * origins should be made to say so rather than get there by omission.
   */
  authorizedParties: readonly string[]
  /**
   * Permitted clock difference against Clerk's `exp`/`nbf`, matching the
   * `clockSkewInMs` option Clerk's own middleware exposes. Defaults to Clerk's
   * default of 5000 ms; jose would otherwise allow none.
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
 * Trailing slashes are not significant in an issuer, but they are significant in
 * string comparison and in URL concatenation. Normalizing once keeps the `iss`
 * claim check and the derived JWKS URL agreeing on a single spelling — Clerk's
 * own `iss` never carries a trailing slash, so a slash-terminated configuration
 * would otherwise reject every token.
 */
function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '')
}

/**
 * Verifies Clerk session JWTs against the Frontend API key set and normalizes them
 * to the provider-neutral identity session interface. Sign-in, sign-up, and session
 * lifecycle stay with Clerk; this adapter only reads a bearer credential.
 */
export function createClerkSessionProvider(options: ClerkSessionProviderOptions): SessionProvider {
  const issuer = normalizeIssuer(requireNonBlank('issuer', options.issuer))
  const jwksUrl =
    options.jwksUrl === undefined
      ? `${issuer}/.well-known/jwks.json`
      : requireNonBlank('jwksUrl', options.jwksUrl)
  const authorizedParties = new Set(
    options.authorizedParties.map((party, index) =>
      requireNonBlank(`authorizedParties[${index}]`, party),
    ),
  )
  // Rejecting the empty list is what makes the option required in practice. Accepting
  // it would restore the silent-off default under a different spelling, and TypeScript
  // cannot catch `[]` the way it catches omission.
  if (authorizedParties.size === 0) {
    throw new TypeError('authorizedParties must list at least one origin')
  }

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
          requiredClaims: ['sub', 'exp', 'sid'],
          clockTolerance: clockSkewInMs / 1_000,
        })
        // `sid` is what makes this a *session* token, and it is an enforced discriminator
        // rather than a convention: Clerk signs custom JWT templates with the same key and
        // issuer, and they carry `sub`, `exp`, and `azp` — but Clerk refuses to mint one
        // carrying `sid`, which is reserved to session-bound tokens. Without this check a
        // token minted for some other service replays here as a login. The type check is
        // the load-bearing half; `requiredClaims` above states the intent but adds no
        // behavior, so do not trim this for looking redundant — a non-string `sid` would
        // then pass.
        if (
          typeof payload.sub !== 'string' ||
          payload.sub.length === 0 ||
          typeof payload.sid !== 'string' ||
          payload.sid.length === 0 ||
          typeof payload.exp !== 'number'
        ) {
          return null
        }
        // An unrecognized `azp` means the token was minted for a different origin
        // than the ones this deployment trusts, so it is a rejected credential
        // rather than an infrastructure fault.
        if (
          authorizedParties.size > 0 &&
          (typeof payload.azp !== 'string' || !authorizedParties.has(payload.azp))
        ) {
          return null
        }

        // `exp` being numeric and unexpired does not make it representable as a Date.
        // A far-future value overflows into an Invalid Date, which serializes to null
        // and compares false against every other date — the credential would look valid
        // while carrying an expiry no consumer can act on. Reject it instead.
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
