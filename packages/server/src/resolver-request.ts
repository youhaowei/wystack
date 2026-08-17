import { CLIENT_CONTEXT_HEADER } from '@wystack/transport'

const DEFAULT_RESOLVER_HEADERS = new Set(['authorization', 'cookie'])

/**
 * Additional ingress-owned headers exposed to resolveContext.
 *
 * Configure these only when a trusted ingress overwrites or removes every
 * client-supplied value for the same names. Authorization and Cookie are always
 * exposed as credentials that the resolver must verify. The client-context
 * carrier is never exposed; its validated value is passed separately.
 */
export type TrustedRequestHeaders = readonly string[]

/** Build the default-deny Request passed across the identity trust boundary. */
export function createResolverRequest(
  request: Request,
  trustedRequestHeaders: TrustedRequestHeaders = [],
): Request {
  const allowed = new Set(DEFAULT_RESOLVER_HEADERS)
  for (const name of trustedRequestHeaders) {
    const normalized = name.toLowerCase()
    if (normalized !== CLIENT_CONTEXT_HEADER.toLowerCase()) allowed.add(normalized)
  }

  const headers = new Headers()
  request.headers.forEach((value, name) => {
    if (allowed.has(name.toLowerCase())) headers.set(name, value)
  })

  const clone = request.clone()
  const init: RequestInit & { duplex?: 'half' } = {
    method: clone.method,
    headers,
    body: clone.method === 'GET' || clone.method === 'HEAD' ? undefined : clone.body,
    redirect: clone.redirect,
    signal: clone.signal,
  }
  if (init.body !== undefined && init.body !== null) init.duplex = 'half'
  return new Request(clone.url, init)
}
