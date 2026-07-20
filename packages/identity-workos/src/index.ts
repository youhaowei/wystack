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

  return createBearerSessionProvider({
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          issuer,
          requiredClaims: ['sub', 'client_id', 'exp'],
        })
        if (
          typeof payload.sub !== 'string' ||
          payload.sub.length === 0 ||
          payload.client_id !== clientId ||
          typeof payload.exp !== 'number'
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
