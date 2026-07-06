// CredentialClass — discriminates which backend policy applies at store time.
//
// Store-time selection: the registry maps each class to a default backend
// (plus a fallback). Read-time does NOT use this — it follows the mapping
// record written at store time (auth-blind, backend-agnostic resolution).

/**
 * Discriminator for backend routing at store time.
 *
 * - `"connector-key"` — API keys / OAuth tokens for data-source connectors.
 * - `"serve-token"`   — tokens used by the WyStack serve layer (e.g. signed
 *                       JWTs, service account credentials).
 * - `"assistant-provider"` — API keys / OAuth credentials for assistant model
 *                            providers.
 *
 * Extensible: add new members as new credential classes are introduced.
 * Existing members MUST NOT be renamed (stored in mapping records).
 */
export type CredentialClass =
  | 'connector-key'
  | 'serve-token'
  | 'assistant-provider'
