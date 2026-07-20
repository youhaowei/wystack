import type { Identity } from './session'

/**
 * The authenticated entity a call acts on behalf of; what authorization
 * decisions are made about. May be a human user or a non-human caller.
 *
 * `Identity` is what an identity provider PRODUCES; `Principal` is what
 * enforcement CONSUMES. Mapping an Identity to a product's own user record
 * is application-owned and never happens in this package.
 */
export type Principal =
  | { kind: 'user'; userId: string; identity?: Identity }
  | { kind: 'service'; credentialId: string }
