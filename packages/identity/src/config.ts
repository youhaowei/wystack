/**
 * Shared validation for provider adapter configuration.
 *
 * Same reasoning as `jwks-url.ts`: these rules are properties of verifying a bearer
 * credential, not of any one provider, and writing them twice is what makes them
 * diverge. That is not hypothetical — `requireNonBlank` was fixed in one adapter and
 * left broken in the other, so a whitespace-padded issuer silently 401'd every request
 * on the copy nobody touched. Pure value logic, so this keeps the package's
 * dependency-free-leaf property.
 */

/**
 * Returns the trimmed value, rejecting one that is blank.
 *
 * Trimming rather than preserving the input, because every option validated here is a
 * copy-paste from a provider dashboard and surrounding whitespace is never meaningful in
 * any of them. It is also not harmless: a client identifier percent-encodes into a JWKS
 * path, so a trailing newline derives `.../client_01ABC%0A`, which 404s — an outage on
 * every verification that reads as a provider problem rather than as a typo in
 * configuration. An issuer fails the same way, silently, by never matching the `iss`
 * claim.
 *
 * Validating the trimmed form while returning the raw one would be the worst of both:
 * the check passes, then the untrimmed value is used anyway.
 */
export function requireNonBlank(name: string, value: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0) throw new TypeError(`${name} must not be blank`)
  return trimmed
}

/**
 * Validates a permitted clock difference, in milliseconds, applying `fallback` when the
 * option is omitted.
 *
 * Validated rather than trusted, because the failure is silent and *inverted*:
 * `clockTolerance: NaN` makes both `exp <= now - NaN` and `nbf > now + NaN` evaluate
 * false, which disables the expiry and not-before checks instead of tightening them. A
 * token that expired years ago would verify. A negative value is rejected on the same
 * principle — it narrows the window rather than widening it, so it is far more likely a
 * unit mix-up than an intent.
 */
export function requireClockSkewInMs(value: number | undefined, fallback = 5_000): number {
  const clockSkewInMs = value ?? fallback
  if (!Number.isFinite(clockSkewInMs) || clockSkewInMs < 0) {
    throw new TypeError('clockSkewInMs must be a non-negative finite number')
  }
  return clockSkewInMs
}

/**
 * Converts a numeric `exp` claim to a `Date`, returning `null` when it is not
 * representable as one.
 *
 * `exp` being numeric and unexpired does not make it representable. `Date`'s ceiling is
 * 8.64e15 ms, so a far-future `exp` overflows into an Invalid Date — which serializes to
 * `null` and compares false against every other date. The credential would look valid
 * while carrying an expiry no consumer can act on, including any caller that decides
 * re-authentication by comparing against it.
 */
export function representableExpiry(exp: number): Date | null {
  const expiresAt = new Date(exp * 1_000)
  return Number.isNaN(expiresAt.getTime()) ? null : expiresAt
}
