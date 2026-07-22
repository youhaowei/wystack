import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose'
import {
  createBearerSessionProvider,
  IdentityProviderUnavailableError,
  representableExpiry,
  requireClockSkewInMs,
  requireNonBlank,
  requireSecureJwksUrl,
  type SessionProvider,
} from '@wystack/identity'

export interface ClerkSessionProviderOptions {
  /** Clerk Frontend API issuer, e.g. `https://<slug>.clerk.accounts.dev`. */
  issuer: string
  /** JSON Web Key Set endpoint. Defaults to `<issuer>/.well-known/jwks.json`. */
  jwksUrl?: string
  /**
   * Origins permitted in Clerk's `azp` claim. Clerk sets `azp` to the requesting
   * origin rather than a client identifier, so this is an allowlist rather than a
   * single expected value.
   *
   * Required, and must list at least one origin. An optional origin check would
   * default to off, which is the wrong default for a security control. A deployment
   * that genuinely cannot enumerate its origins should be made to say so rather than
   * get there by omission.
   *
   * Note this makes *configuration* mandatory, not the claim. Tokens that omit `azp`
   * skip the check, because Clerk documents the claim as omissible — see the
   * verification path. `identity-workos` requires its `clientId` for a superficially
   * similar reason, but it binds the client through the key set rather than a claim:
   * WorkOS serves a key set per client and issues no `client_id` claim, so there is
   * nothing there for a claim-presence check to be parity with.
   */
  authorizedParties: readonly string[]
  /**
   * Permitted clock difference against Clerk's `exp`/`nbf`, matching the
   * `clockSkewInMs` option Clerk's own middleware exposes. Defaults to Clerk's
   * default of 5000 ms; jose would otherwise allow none.
   */
  clockSkewInMs?: number
}

/**
 * Classifies a jose error raised *after* a key set was successfully fetched — a malformed
 * key, an unusable key set, a non-200 response.
 *
 * Transport failures do not reach here; `customFetch` below intercepts them at the fetch.
 * That makes the `JWKSTimeout` clause unreachable today, since jose constructs that type
 * only when converting a fetch rejection it never gets to see. It is kept deliberately:
 * it costs nothing, and it is what this function would need if the `customFetch` wrapper
 * were ever removed — leaving it out would turn that removal into a silent
 * misclassification rather than a loud one.
 */
function isJwksInfrastructureError(error: unknown): boolean {
  return (
    error instanceof errors.JWKSTimeout ||
    error instanceof errors.JWKSInvalid ||
    error instanceof errors.JWKInvalid ||
    (error instanceof errors.JOSEError && error.constructor === errors.JOSEError)
  )
}

/**
 * Trailing slashes are not significant in an issuer, but they are significant in
 * string comparison and in URL concatenation. Normalizing once keeps the `iss`
 * claim check and the derived JWKS URL agreeing on a single spelling — Clerk's
 * own `iss` never carries a trailing slash, so a slash-terminated configuration
 * would otherwise reject every token.
 */
function normalizeIssuer(issuer: string): string {
  return issuer.replace(/\/+$/, '')
}

/**
 * Verifies Clerk session JWTs against the Frontend API key set and normalizes them
 * to the provider-neutral identity session interface. Sign-in, sign-up, and session
 * lifecycle stay with Clerk; this adapter only reads a bearer credential.
 */
export function createClerkSessionProvider(options: ClerkSessionProviderOptions): SessionProvider {
  const issuer = normalizeIssuer(requireNonBlank('issuer', options.issuer))
  // Guarded on the *effective* URL, after derivation, so an `http://` issuer is caught
  // too — otherwise the check would pass on a `jwksUrl` nobody set and the insecure
  // value would reach the fetch anyway. Key retrieval is the root of trust: an attacker
  // who substitutes the key set mints tokens that satisfy every other check, because
  // they hold the private half of the key this verifier is told to trust.
  //
  // The name reported is whichever option the operator actually set, so the error points
  // at `issuer` when the URL was derived from it.
  const jwksUrl =
    options.jwksUrl === undefined
      ? requireSecureJwksUrl('issuer', `${issuer}/.well-known/jwks.json`)
      : requireSecureJwksUrl('jwksUrl', requireNonBlank('jwksUrl', options.jwksUrl))
  const authorizedParties = new Set(
    options.authorizedParties.map((party, index) =>
      requireNonBlank(`authorizedParties[${index}]`, party),
    ),
  )
  // Rejecting the empty list is what makes the option required in practice. Accepting
  // it would restore the silent-off default under a different spelling, and TypeScript
  // cannot catch `[]` the way it catches omission.
  if (authorizedParties.size === 0) {
    throw new TypeError('authorizedParties must list at least one origin')
  }

  const clockSkewInMs = requireClockSkewInMs(options.clockSkewInMs)

  // `customFetch` rather than classifying the thrown error afterwards, because the
  // classification is not expressible after the fact. jose converts only a timeout into
  // a `JWKSTimeout`; connection refused, DNS failure, TLS failure and network partition
  // are rethrown as whatever the platform's `fetch` produced — a bare `Error` on Bun, a
  // `TypeError` on Node — with nothing to distinguish them from a defect in the verify
  // closure. Those are the *headline* outage shapes, so classifying only after the throw
  // would leave every case except a 5xx from a healthy-enough key server unlabelled.
  //
  // Wrapping at the fetch call makes the distinction structural: anything rejecting here
  // is a transport failure against the key endpoint by construction, and nothing else in
  // the provider passes through this function.
  const jwks = createRemoteJWKSet(new URL(jwksUrl), {
    [customFetch]: async (url, init) => {
      try {
        return await fetch(url, init)
      } catch (error) {
        throw new IdentityProviderUnavailableError('Clerk key set endpoint could not be reached', {
          cause: error,
        })
      }
    },
  })

  return createBearerSessionProvider({
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          algorithms: ['RS256'],
          issuer,
          requiredClaims: ['sub', 'exp', 'sid'],
          clockTolerance: clockSkewInMs / 1_000,
        })
        // `sid` is what makes this a *session* token, and it is an enforced discriminator
        // rather than a convention: Clerk signs custom JWT templates with the same key and
        // issuer, and they carry `sub`, `exp`, and `azp` — but Clerk refuses to mint one
        // carrying `sid`, which is reserved to session-bound tokens. Without this check a
        // token minted for some other service replays here as a login. The type check is
        // the load-bearing half; `requiredClaims` above states the intent but adds no
        // behavior, so do not trim this for looking redundant — a non-string `sid` would
        // then pass.
        if (
          typeof payload.sub !== 'string' ||
          payload.sub.length === 0 ||
          typeof payload.sid !== 'string' ||
          payload.sid.length === 0 ||
          typeof payload.exp !== 'number'
        ) {
          return null
        }
        // A *present* `azp` outside the allowlist means the token was minted for an
        // origin this deployment does not trust, so it is a rejected credential rather
        // than an infrastructure fault.
        //
        // An *absent* `azp` is skipped rather than rejected, which is the one place this
        // provider is deliberately lenient. Clerk documents `azp` as omissible — it
        // carries the `Origin` header of the originating Frontend API request, and Clerk
        // drops the claim entirely when that header is empty or null (sandboxed iframes,
        // some native webviews, privacy-hardened browsers). Clerk's own verification
        // guidance and backend SDK skip the check when the claim is absent, so rejecting
        // here would 401 genuine session tokens permanently, with no configuration that
        // could accept them. That failure is invisible in development, where browsers
        // always send `Origin`.
        //
        // What keeps this safe is that `azp` is not the discriminator. `sid` above is —
        // it is platform-enforced and carries no omission caveat. `azp` adds origin
        // binding on top, best-effort by design, and the attack it defends against
        // (a token minted for an untrusted origin) still carries an `azp` and is still
        // rejected by the branch below.
        // Absence is `undefined`/`null` specifically, not "fails a type check". A
        // numeric or object `azp` is malformed rather than omitted, and skipping on
        // `typeof !== 'string'` would accept it — so those still fall through to the
        // reject. Clerk's own guard has the same shape.
        const azp = payload.azp
        if (azp !== undefined && azp !== null) {
          if (typeof azp !== 'string' || !authorizedParties.has(azp)) return null
        }

        const expiresAt = representableExpiry(payload.exp)
        if (expiresAt === null) return null

        return {
          identity: { subject: payload.sub },
          expiresAt,
        }
      } catch (error) {
        // Re-raise infrastructure faults as a seam-level type so callers can tell an
        // upstream outage from a rejected credential without importing jose and
        // reimplementing this classification. Without it the distinction is drawn
        // correctly here and then lost by every consumer.
        if (isJwksInfrastructureError(error)) {
          throw new IdentityProviderUnavailableError(
            'Clerk key set could not be retrieved or used',
            {
              cause: error,
            },
          )
        }

        // Any other jose error is the token failing verification — a rejected
        // credential, which the interface expresses as `null`.
        if (error instanceof errors.JOSEError) return null

        // Anything else is a defect in this closure, not a statement about the token or
        // about Clerk. Rethrown unchanged so it surfaces as a server fault: labelling it
        // as provider-unavailable would make callers answer 503 and mark it retryable, so
        // clients would keep retrying a deterministic bug that never clears.
        //
        // Transport failures do not reach here needing a label — `customFetch` above
        // already threw `IdentityProviderUnavailableError`, and this rethrows it
        // unchanged.
        throw error
      }
    },
  })
}
