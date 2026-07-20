/** A verified identity from an authentication system, independent of product authorization. */
export interface Identity {
  /** Stable provider subject. The application maps this to its own local user record. */
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
      const scheme = 'Bearer '
      // RFC 7235: the auth scheme is case-insensitive. `bearer` and `BEARER`
      // are standards-compliant and must not be read as "no credential".
      const isBearer = authorization?.slice(0, scheme.length).toLowerCase() === scheme.toLowerCase()
      const headerToken = isBearer ? authorization!.slice(scheme.length).trim() : null

      // A bearer-shaped Authorization header is an explicit assertion of scheme,
      // so its token decides the outcome — including when it is empty. Falling
      // through to the query token here would let a malformed header silently
      // downgrade to a weaker credential path instead of denying.
      if (headerToken !== null) {
        return headerToken ? options.verify(headerToken) : null
      }

      const queryToken = options.allowQueryToken?.(request)
        ? new URL(request.url).searchParams.get('token')
        : null

      return queryToken ? options.verify(queryToken) : null
    },
  }
}
