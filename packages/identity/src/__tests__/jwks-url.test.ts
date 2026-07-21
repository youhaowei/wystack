import { describe, expect, test } from 'bun:test'
import { requireSecureJwksUrl } from '../jwks-url'

describe('requireSecureJwksUrl', () => {
  test('accepts https and returns the input unchanged', () => {
    const url = 'https://api.workos.com/sso/jwks/client_01TEST'
    expect(requireSecureJwksUrl('jwksUrl', url)).toBe(url)
  })

  test('rejects plain http on a routable host', () => {
    expect(() => requireSecureJwksUrl('jwksUrl', 'http://api.workos.com/jwks')).toThrow(
      'jwksUrl must use https',
    )
  })

  test('permits http on loopback hosts only', () => {
    // The exemption exists so test suites can serve fixtures in-process. A loopback
    // endpoint is reachable only by code already on the machine — a party with more
    // direct ways to subvert verification than substituting a key set.
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      expect(requireSecureJwksUrl('jwksUrl', `http://${host}:8080/jwks`)).toBeTruthy()
    }
  })

  test('does not treat private-range addresses as loopback', () => {
    // The distinction that matters: private does not mean local. Traffic to 10.0.0.5
    // or 192.168.1.10 crosses a network someone can be on, which is the threat.
    for (const host of ['10.0.0.5', '192.168.1.10', '172.16.0.1']) {
      expect(() => requireSecureJwksUrl('jwksUrl', `http://${host}/jwks`)).toThrow(
        'must use https',
      )
    }
  })

  test('rejects hosts that merely look like loopback', () => {
    // Substring matching would accept all of these. `localhost.evil.com` resolves
    // wherever the attacker points it, and `127.0.0.1.evil.com` is an ordinary domain.
    for (const host of ['localhost.evil.com', '127.0.0.1.evil.com', 'notlocalhost']) {
      expect(() => requireSecureJwksUrl('jwksUrl', `http://${host}/jwks`)).toThrow(
        'must use https',
      )
    }
  })

  test('rejects non-http protocols', () => {
    // `file:` would read keys off local disk and `ftp:` is unauthenticated too; neither
    // is a transport this should silently accept.
    expect(() => requireSecureJwksUrl('jwksUrl', 'file:///etc/keys.json')).toThrow(
      'must use https',
    )
  })

  test('rejects a relative or malformed URL with a distinct message', () => {
    // Distinct from the protocol error, so a typo does not read as a security refusal.
    expect(() => requireSecureJwksUrl('jwksUrl', '/.well-known/jwks.json')).toThrow(
      'jwksUrl must be an absolute URL',
    )
  })

  test('quotes the option name it was given', () => {
    // Clerk derives its JWKS URL from `issuer`, so the error has to name whichever
    // option the operator actually set.
    expect(() => requireSecureJwksUrl('issuer', 'http://clerk.example.test')).toThrow(
      'issuer must use https',
    )
  })
})
