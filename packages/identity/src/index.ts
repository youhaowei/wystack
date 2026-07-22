// @wystack/identity
// Provider-neutral identity, session, and principal boundary.
//
// Dependency-free leaf by design: client bundles depend on this package, so it
// must never pull server or database code into a browser build.

export {
  type Identity,
  type AuthSession,
  type SessionProvider,
  type ClientAuthState,
  type BearerSessionProviderOptions,
  createBearerSessionProvider,
} from './session'
export { type Principal, type PrincipalKind, isPrincipal } from './principal'
export { requireSecureJwksUrl } from './jwks-url'
export { requireNonBlank, requireClockSkewInMs, representableExpiry } from './config'
