/** A verified identity from an authentication system, independent of product authorization. */
export interface Identity {
  /** Stable provider subject. WorkHub maps this to its own local user record. */
  subject: string
  email?: string | null
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

export type AuthMode = 'local' | 'remote'

export interface SessionResolverOptions {
  mode: AuthMode
  /** Embedded provider, such as Better Auth in a WorkHub deployment. */
  local?: SessionProvider
  /** Hosted identity provider, such as a future Lumony Auth deployment. */
  remote?: SessionProvider
}

/**
 * Selects a trusted session provider without coupling WyStack to an auth vendor.
 * The provider validates identity; product code resolves tenant membership and roles.
 */
export function createSessionResolver(
  options: SessionResolverOptions,
): SessionProvider['getSession'] {
  return async (request) => {
    const provider = options.mode === 'local' ? options.local : options.remote
    if (!provider) throw new Error(`No ${options.mode} session provider is configured`)
    return provider.getSession(request)
  }
}
