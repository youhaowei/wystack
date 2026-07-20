import { createRemoteJWKSet, errors, jwtVerify } from 'jose'
import { createBearerSessionProvider, type SessionProvider } from '@wystack/identity'

export interface WorkOSSessionProviderOptions {
  /** Client-specific WorkOS JSON Web Key Set endpoint. */
  jwksUrl: string
  /** WorkOS application client ID expected in the access token. */
  clientId: string
  /** Expected token issuer, including a configured custom AuthKit domain. */
  issuer: string
}

function isInvalidCredentialError(error: unknown): boolean {
  return (
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTExpired ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys ||
    error instanceof errors.JWSSignatureVerificationFailed
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
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl))

  return createBearerSessionProvider({
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          issuer: options.issuer,
          requiredClaims: ['sub', 'client_id', 'exp'],
        })
        if (
          typeof payload.sub !== 'string' ||
          payload.sub.length === 0 ||
          payload.client_id !== options.clientId ||
          typeof payload.exp !== 'number'
        ) {
          return null
        }

        return {
          identity: { subject: payload.sub },
          expiresAt: new Date(payload.exp * 1_000),
        }
      } catch (error) {
        if (isInvalidCredentialError(error)) return null
        throw error
      }
    },
  })
}
