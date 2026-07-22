/**
 * Shared validation for JSON Web Key Set (JWKS) endpoints.
 *
 * Lives in the seam rather than in each adapter because the rule is a property of
 * fetching signing keys, not of any one provider — and because the adapters have
 * repeatedly diverged when the same guard was written twice. Pure URL logic, so it does
 * not compromise this package's dependency-free-leaf property.
 */

/**
 * Hosts permitted to serve a key set over plain HTTP.
 *
 * Loopback only, and enumerated rather than pattern-matched: `localhost` resolves
 * through the host's resolver and `127.0.0.1`/`[::1]` are the literal loopback
 * addresses. Anything else — including a private-range address like `10.0.0.5` — is a
 * network hop an attacker can sit on, which is the entire threat being closed here.
 *
 * Compared against `URL.hostname`, so every entry must be in the form the WHATWG parser
 * produces: IPv6 is always bracketed there, which is why `[::1]` appears and a bare
 * `::1` would be unreachable. Matching the normalized form is what makes the set fail
 * closed on novel spellings for free — `127.1`, `2130706433` and `0x7f.1` all normalize
 * to `127.0.0.1` before they are looked up, while `localhost.` and
 * `localhost@evil.com` do not normalize to anything in the set.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname)
}

/**
 * Rejects a JWKS endpoint that would fetch signing keys over an interceptable channel.
 *
 * Key retrieval is the root of trust for token verification: an attacker who can
 * substitute the key set can mint a token that satisfies every other check — issuer,
 * audience, expiry, subject — because they hold the private half of the key the verifier
 * is told to trust. Plain HTTP puts that substitution within reach of anyone on the
 * network path.
 *
 * Throws at construction rather than failing at first verification, so a misconfigured
 * deployment fails to start instead of appearing healthy and then rejecting every
 * request under load.
 *
 * HTTP is permitted for loopback hosts only, so test suites can serve fixtures from an
 * in-process server. That exemption is deliberately narrow: a loopback endpoint is
 * reachable only by code already running on the machine, which is a party that has
 * strictly more direct ways to subvert verification than swapping a key set.
 *
 * @param name  option name to quote in the error, e.g. `'jwksUrl'`
 * @param value the effective URL, after any derivation from an issuer or client id
 * @returns the same string, so this can wrap an assignment
 */
export function requireSecureJwksUrl(name: string, value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError(`${name} must be an absolute URL`)
  }

  if (url.protocol === 'https:') return value
  if (url.protocol === 'http:' && isLoopback(url)) return value

  throw new TypeError(
    `${name} must use https (got ${url.protocol}//${url.host}); plain http is permitted only for loopback hosts`,
  )
}
