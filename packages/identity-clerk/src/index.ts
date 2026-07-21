import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { createBearerSessionProvider, type SessionProvider } from '@wystack/identity'

export interface ClerkSessionProviderOptions {
  /** Clerk Frontend API issuer, e.g. `https://<slug>.clerk.accounts.dev`. */
  issuer: string
  /** JSON Web Key Set endpoint. Defaults to `<issuer>/.well-known/jwks.json`. */
  jwksUrl?: string
  /**
   * Origins permitted in Clerk's `azp` claim. Clerk sets `azp` to the requesting
   * origin rather than a client identifier, so this is an allowlist, not a single
   * expected value. Omitted or empty disables the check.
   */
  authorizedParties?: readonly string[]
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
    (options.authorizedParties ?? []).map((party, index) =>
      requireNonBlank(`authorizedParties[${index}]`, party),
    ),
  )

  const jwks = createRemoteJWKSet(new URL(jwksUrl))

  return createBearerSessionProvider({
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          issuer,
          requiredClaims: ['sub', 'exp', 'sid'],
        })
        // `sid` is what makes this a *session* token. Clerk signs custom JWT templates
        // with the same key and issuer, and they carry `sub`, `exp`, and `azp` — but
        // deliberately omit `sid`, because they are not bound to a session. Without this
        // check a token minted for some other service replays here as a login.
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

        return {
          identity: { subject: payload.sub },
          expiresAt: new Date(payload.exp * 1_000),
        }
      } catch (error) {
        if (error instanceof errors.JOSEError && !isJwksInfrastructureError(error)) return null
        throw error
      }
    },
  })
}
