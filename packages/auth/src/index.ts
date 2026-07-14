/** A verified identity from an authentication system, independent of product authorization. */
export interface Identity {
  /** Stable provider subject. WorkHub maps this to its own local user record. */
  subject: string
  email?: string | null
  emailVerified?: boolean
  name?: string | null
  image?: string | null
}

export interface AuthSession {
  identity: Identity
  expiresAt?: Date
}

/**
 * A trusted adapter that validates an incoming request and returns its session.
 * Implementations own cookie/JWT validation; callers must never trust raw headers.
 */
export interface SessionProvider {
  getSession(request: Request): Promise<AuthSession | null>
}

/** Provider-neutral client auth state consumed by browser integrations. */
export interface ClientAuthState {
  isLoaded: boolean
  isSignedIn: boolean
  getToken(): Promise<string | null>
}

export interface BearerSessionProviderOptions {
  /** Verifies a provider-issued token and normalizes its identity. */
  verify(token: string): Promise<AuthSession | null>
  /** Restrict query credentials to a trusted transport, normally a WebSocket upgrade. */
  allowQueryToken?: (request: Request) => boolean
}

/**
 * Creates a provider-neutral request adapter for bearer-token authentication.
 * Token verification remains owned by the selected auth provider adapter.
 */
export function createBearerSessionProvider(
  options: BearerSessionProviderOptions,
): SessionProvider {
  return {
    async getSession(request) {
      const authorization = request.headers.get('authorization')
      const headerToken = authorization?.startsWith('Bearer ')
        ? authorization.slice('Bearer '.length).trim()
        : null
      const queryToken = options.allowQueryToken?.(request)
        ? new URL(request.url).searchParams.get('token')
        : null
      const token = headerToken || queryToken

      return token ? options.verify(token) : null
    },
  }
}
