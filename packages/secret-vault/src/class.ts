// CredentialClass — discriminates which backend policy applies at store time.
//
// Store-time selection: the registry maps each class to a default backend
// (plus a fallback). Read-time does NOT use this — it follows the mapping
// record written at store time (auth-blind, backend-agnostic resolution).

/**
 * Application-defined string identifier for backend routing at store time.
 *
 * Like backend names passed to {@link SecretRegistry.register}, applications
 * define classes at composition time. Any value used as a class after secrets
 * are stored under it MUST NOT be renamed or repurposed: the class selects the
 * backend at store time, so renaming silently re-routes new secrets while old
 * refs keep resolving through the backend recorded in their mapping.
 */
export type CredentialClass = string
