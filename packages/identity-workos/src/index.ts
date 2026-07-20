import { createRemoteJWKSet, jwtVerify } from 'jose'
import { createBearerSessionProvider, type SessionProvider } from '@wystack/identity'

export interface WorkOSSessionProviderOptions {
  /** Client-specific WorkOS JSON Web Key Set endpoint. */
  jwksUrl: string
  /** WorkOS application client ID expected in the access token. */
  clientId: string
  /** Expected token issuer, including a configured custom AuthKit domain. */
  issuer: string
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
        })
        if (!payload.sub || payload.client_id !== options.clientId) return null

        return {
          identity: { subject: payload.sub },
          ...(payload.exp ? { expiresAt: new Date(payload.exp * 1_000) } : {}),
        }
      } catch {
        return null
      }
    },
  })
}
