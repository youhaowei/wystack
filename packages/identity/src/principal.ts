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

export type PrincipalKind = Principal['kind']

type PrincipalValidator = (value: object) => boolean

const principalValidators = {
  user: (value) => {
    const { userId } = value as { userId?: unknown }
    return typeof userId === 'string' && userId.length > 0
  },
  service: (value) => {
    const { credentialId } = value as { credentialId?: unknown }
    return typeof credentialId === 'string' && credentialId.length > 0
  },
} satisfies Record<PrincipalKind, PrincipalValidator>

/** Narrows an untrusted value to a Principal, denying unknown or malformed kinds. */
export function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== 'object' || value === null) return false

  try {
    const { kind } = value as { kind?: unknown }
    if (typeof kind !== 'string') return false
    if (!Object.hasOwn(principalValidators, kind)) return false

    return principalValidators[kind as PrincipalKind](value) === true
  } catch {
    return false
  }
}
