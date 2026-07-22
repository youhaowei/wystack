/**
 * Errors that cross the identity seam.
 *
 * A session provider distinguishes two failures that look identical to a naive caller:
 * the credential was rejected, and the provider could not be consulted. Only the first
 * is an authentication failure. Conflating them turns an upstream outage into a
 * site-wide sign-out, and points incident response at the wrong system.
 *
 * `getSession` already expresses the first case by resolving `null`. This type expresses
 * the second, so callers classify by an explicit contract rather than by inspecting
 * whichever error a verification library happened to raise.
 */

/**
 * The identity provider could not be reached or answered unusably.
 *
 * Thrown for infrastructure faults — an unreachable key endpoint, a timeout, a 5xx, a
 * malformed key set. A rejected token resolves `null`.
 *
 * A bogus token can still reach this error, and that is correct rather than a leak in
 * the classification: verifiers refetch the key set when a token names an unknown key,
 * so a token that would be rejected by a healthy provider raises a fetch failure against
 * a broken one. While the key set is unreachable the token is *unadjudicable*, not
 * rejected — the honest answer is "ask again", and it becomes `null` as soon as the
 * provider recovers. What this type promises is the direction of the mistake, not that
 * the input was well-formed: nothing resolves `null` because of an outage, and nothing
 * throws this because a credential was merely wrong.
 *
 * Callers should treat this as a dependency failure (5xx, retryable close) rather than
 * as an authentication failure (401, terminal close). The distinction is what keeps a
 * transient outage at the provider from presenting as every user's credentials becoming
 * invalid at once.
 */
export class IdentityProviderUnavailableError extends Error {
  override readonly name = 'IdentityProviderUnavailableError'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
  }
}

/**
 * Narrows an unknown thrown value to a provider-unavailability fault.
 *
 * Prefer this over `instanceof` at package boundaries. Duplicate copies of a package can
 * coexist in one dependency tree — two versions of `@wystack/identity`, or a bundled and
 * an unbundled copy — and `instanceof` fails across them even though the class is
 * nominally the same. That failure mode is silent and would resolve in exactly the wrong
 * direction here: an unrecognized outage falls back to being reported as an auth
 * failure, which is the bug this type exists to fix.
 */
export function isIdentityProviderUnavailable(
  error: unknown,
): error is IdentityProviderUnavailableError {
  return (
    error instanceof IdentityProviderUnavailableError ||
    (error instanceof Error && error.name === 'IdentityProviderUnavailableError')
  )
}
