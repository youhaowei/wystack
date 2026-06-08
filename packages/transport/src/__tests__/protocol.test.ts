import { describe, test, expect } from 'bun:test'
import {
  parseClientMessage,
  parseServerMessage,
  parseEnvelope,
  REACTIVITY_NOT_ENABLED,
  type AuthMessage,
  type SubscribeMessage,
  type UnsubscribeMessage,
  type CallMessage,
  type AuthenticatedMessage,
  type SubscribedMessage,
  type InvalidateMessage,
  type ResultMessage,
  type ErrorMessage,
  type ClientMessage,
  type ServerMessage,
  type NextMessage,
  type ResyncMessage,
} from '../index'

// ─── Type-level sanity (zero runtime — checks the union surface) ─────────────
// If any active kind drops out of ClientMessage / ServerMessage, these
// assignments stop compiling. Reserved kinds are intentionally NOT assignable
// to the active unions.

const _typeChecks = (): void => {
  const a: AuthMessage = { type: 'auth', token: null }
  const s: SubscribeMessage = { type: 'subscribe', id: 'x', path: 'p', args: {} }
  const u: UnsubscribeMessage = { type: 'unsubscribe', id: 'x' }
  const c: CallMessage = { type: 'call', id: 'x', path: 'p', args: {} }
  const _client: ClientMessage[] = [a, s, u, c]
  void _client

  const ack: AuthenticatedMessage = { type: 'authenticated' }
  const sub: SubscribedMessage = { type: 'subscribed', id: 'x' }
  const inv: InvalidateMessage = { type: 'invalidate', id: 'x' }
  const res: ResultMessage = { type: 'result', id: 'x', data: { ok: true } }
  const err: ErrorMessage = { type: 'error', error: 'boom' }
  const _server: ServerMessage[] = [ack, sub, inv, res, err]
  void _server

  // Reserved kinds: typed but NOT in active unions. The next two lines
  // construct them to ensure the types are exported; they intentionally
  // are not assigned into `_client`/`_server`.
  const next: NextMessage = { type: 'next', id: 'x', version: 1 }
  const resync: ResyncMessage = { type: 'resync', id: 'x' }
  void next
  void resync
}
void _typeChecks

// ─── parseClientMessage: envelope rejection ──────────────────────────────────

describe('parseClientMessage — envelope rejection', () => {
  test('rejects non-JSON', () => {
    expect(parseClientMessage('not json')).toBeNull()
    expect(parseClientMessage('')).toBeNull()
  })
  test('rejects non-object JSON', () => {
    expect(parseClientMessage('null')).toBeNull()
    expect(parseClientMessage('42')).toBeNull()
    expect(parseClientMessage('"auth"')).toBeNull()
    expect(parseClientMessage('true')).toBeNull()
    expect(parseClientMessage('[]')).toBeNull()
    expect(parseClientMessage('[{"type":"auth","token":null}]')).toBeNull()
  })
  test('rejects missing or non-string type', () => {
    expect(parseClientMessage('{}')).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 1 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: null }))).toBeNull()
  })
  test('rejects unknown discriminant', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'nope' }))).toBeNull()
    // Reserved kinds are NOT in the active union — must be rejected.
    expect(parseClientMessage(JSON.stringify({ type: 'next', id: 'x', version: 1 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'resync', id: 'x' }))).toBeNull()
    // Server-side type values must NOT round-trip through the client parser.
    expect(parseClientMessage(JSON.stringify({ type: 'authenticated' }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'subscribed', id: 'x' }))).toBeNull()
  })
})

// ─── parseClientMessage: per-kind ────────────────────────────────────────────

describe('parseClientMessage — auth', () => {
  test('accepts a string token', () => {
    const got = parseClientMessage(JSON.stringify({ type: 'auth', token: 'jwt' }))
    expect(got).toEqual({ type: 'auth', token: 'jwt' })
  })
  test('accepts a null token (anonymous)', () => {
    const got = parseClientMessage(JSON.stringify({ type: 'auth', token: null }))
    expect(got).toEqual({ type: 'auth', token: null })
  })
  test('rejects a missing token field', () => {
    // The wire requires token to be present; the server coerces non-string to
    // null but the parser is strict (see AuthMessage doc).
    expect(parseClientMessage(JSON.stringify({ type: 'auth' }))).toBeNull()
  })
  test('rejects a non-string, non-null token', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'auth', token: 42 }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'auth', token: {} }))).toBeNull()
    expect(parseClientMessage(JSON.stringify({ type: 'auth', token: [] }))).toBeNull()
  })
})

describe('parseClientMessage — subscribe', () => {
  test('accepts a full subscribe', () => {
    const got = parseClientMessage(
      JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'users.list', args: { limit: 10 } }),
    )
    expect(got).toEqual({
      type: 'subscribe',
      id: 'sub1',
      path: 'users.list',
      args: { limit: 10 },
    })
  })
  test('accepts an empty args object', () => {
    const got = parseClientMessage(
      JSON.stringify({ type: 'subscribe', id: 'sub1', path: 'users.list', args: {} }),
    )
    expect(got).toEqual({ type: 'subscribe', id: 'sub1', path: 'users.list', args: {} })
  })
  test('rejects missing id', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'subscribe', path: 'p', args: {} })),
    ).toBeNull()
  })
  test('rejects non-string id', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'subscribe', id: 1, path: 'p', args: {} })),
    ).toBeNull()
  })
  test('rejects missing path', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'subscribe', id: 'x', args: {} }))).toBeNull()
  })
  test('rejects non-string path', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'subscribe', id: 'x', path: 1, args: {} })),
    ).toBeNull()
  })
  test('rejects missing args', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'subscribe', id: 'x', path: 'p' }))).toBeNull()
  })
  test('rejects non-object args', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'subscribe', id: 'x', path: 'p', args: 'oops' })),
    ).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'subscribe', id: 'x', path: 'p', args: [] })),
    ).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'subscribe', id: 'x', path: 'p', args: null })),
    ).toBeNull()
  })
})

describe('parseClientMessage — unsubscribe', () => {
  test('accepts a valid unsubscribe', () => {
    const got = parseClientMessage(JSON.stringify({ type: 'unsubscribe', id: 'sub1' }))
    expect(got).toEqual({ type: 'unsubscribe', id: 'sub1' })
  })
  test('rejects missing id', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'unsubscribe' }))).toBeNull()
  })
  test('rejects non-string id', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'unsubscribe', id: 1 }))).toBeNull()
  })
})

describe('parseClientMessage — call', () => {
  test('accepts a full call', () => {
    const got = parseClientMessage(
      JSON.stringify({ type: 'call', id: 'c1', path: 'users.get', args: { id: 7 } }),
    )
    expect(got).toEqual({ type: 'call', id: 'c1', path: 'users.get', args: { id: 7 } })
  })
  test('accepts an empty args object', () => {
    expect(
      parseClientMessage(JSON.stringify({ type: 'call', id: 'c1', path: 'p', args: {} })),
    ).toEqual({ type: 'call', id: 'c1', path: 'p', args: {} })
  })
  test('rejects missing id', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'call', path: 'p', args: {} }))).toBeNull()
  })
  test('rejects missing path', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'call', id: 'c1', args: {} }))).toBeNull()
  })
  test('rejects missing or non-object args', () => {
    expect(parseClientMessage(JSON.stringify({ type: 'call', id: 'c1', path: 'p' }))).toBeNull()
    expect(
      parseClientMessage(JSON.stringify({ type: 'call', id: 'c1', path: 'p', args: 1 })),
    ).toBeNull()
  })
})

// ─── parseServerMessage: envelope rejection ──────────────────────────────────

describe('parseServerMessage — envelope rejection', () => {
  test('rejects non-JSON', () => {
    expect(parseServerMessage('not json')).toBeNull()
  })
  test('rejects non-object JSON', () => {
    expect(parseServerMessage('null')).toBeNull()
    expect(parseServerMessage('42')).toBeNull()
    expect(parseServerMessage('[]')).toBeNull()
  })
  test('rejects missing or non-string type', () => {
    expect(parseServerMessage('{}')).toBeNull()
    expect(parseServerMessage(JSON.stringify({ type: 1 }))).toBeNull()
  })
  test('rejects unknown discriminant', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'nope' }))).toBeNull()
    // Client-side kinds must NOT round-trip through the server parser.
    expect(parseServerMessage(JSON.stringify({ type: 'auth', token: null }))).toBeNull()
    expect(
      parseServerMessage(JSON.stringify({ type: 'subscribe', id: 'x', path: 'p', args: {} })),
    ).toBeNull()
    // Reserved kinds are NOT in the active union.
    expect(parseServerMessage(JSON.stringify({ type: 'next', id: 'x', version: 1 }))).toBeNull()
    expect(parseServerMessage(JSON.stringify({ type: 'resync', id: 'x' }))).toBeNull()
  })
  test('rejects prototype-key discriminants without throwing', () => {
    for (const type of ['__proto__', 'constructor', 'toString']) {
      const frame = JSON.stringify({ type, error: 'boom' })

      expect(() => parseServerMessage(frame)).not.toThrow()
      expect(parseServerMessage(frame)).toBeNull()
    }
  })
})

// ─── parseServerMessage: per-kind ────────────────────────────────────────────

describe('parseServerMessage — authenticated', () => {
  test('accepts an authenticated ack', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'authenticated' }))).toEqual({
      type: 'authenticated',
    })
  })
  test('ignores extra fields on authenticated', () => {
    // Forward-compat: extra fields on a known type are accepted; the parser
    // returns the canonical shape. Mirrors the loose-by-construction wire.
    expect(parseServerMessage(JSON.stringify({ type: 'authenticated', extra: 'x' }))).toEqual({
      type: 'authenticated',
    })
  })
})

describe('parseServerMessage — subscribed', () => {
  test('accepts a valid subscribed', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'subscribed', id: 'sub1' }))).toEqual({
      type: 'subscribed',
      id: 'sub1',
    })
  })
  test('rejects missing id', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'subscribed' }))).toBeNull()
  })
  test('rejects non-string id', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'subscribed', id: 1 }))).toBeNull()
  })
})

describe('parseServerMessage — invalidate', () => {
  test('accepts a valid invalidate', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'invalidate', id: 'sub1' }))).toEqual({
      type: 'invalidate',
      id: 'sub1',
    })
  })
  test('rejects missing id', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'invalidate' }))).toBeNull()
  })
  test('rejects non-string id', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'invalidate', id: 1 }))).toBeNull()
  })
})

describe('parseServerMessage — error', () => {
  test('accepts an error without id', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'error', error: 'boom' }))).toEqual({
      type: 'error',
      error: 'boom',
    })
  })
  test('accepts an error with id', () => {
    expect(
      parseServerMessage(JSON.stringify({ type: 'error', id: 'sub1', error: 'boom' })),
    ).toEqual({ type: 'error', id: 'sub1', error: 'boom' })
  })
  test('accepts an error with issues', () => {
    const got = parseServerMessage(
      JSON.stringify({
        type: 'error',
        id: 'sub1',
        error: 'validation',
        issues: [{ path: ['x'], message: 'required' }],
      }),
    )
    expect(got).toEqual({
      type: 'error',
      id: 'sub1',
      error: 'validation',
      issues: [{ path: ['x'], message: 'required' }],
    })
  })
  test('omits id when it was absent on the wire', () => {
    const got = parseServerMessage(JSON.stringify({ type: 'error', error: 'boom' }))
    expect(got).not.toBeNull()
    expect(Object.hasOwn(got as object, 'id')).toBe(false)
  })
  test('rejects missing error field', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'error' }))).toBeNull()
  })
  test('rejects non-string error', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'error', error: 1 }))).toBeNull()
  })
  test('rejects non-string id when present', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'error', id: 1, error: 'boom' }))).toBeNull()
  })
  test('rejects non-string kind when present', () => {
    expect(
      parseServerMessage(JSON.stringify({ type: 'error', kind: 123, error: 'boom' })),
    ).toBeNull()
    expect(
      parseServerMessage(JSON.stringify({ type: 'error', kind: false, error: 'boom' })),
    ).toBeNull()
  })
  test('rejects non-array issues when present', () => {
    expect(
      parseServerMessage(JSON.stringify({ type: 'error', error: 'boom', issues: 'oops' })),
    ).toBeNull()
  })
  test('accepts kind:call and threads it through', () => {
    expect(
      parseServerMessage(JSON.stringify({ type: 'error', kind: 'call', id: 'c1', error: 'oops' })),
    ).toEqual({ type: 'error', kind: 'call', id: 'c1', error: 'oops' })
  })
  test('accepts kind:subscription and threads it through', () => {
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'error', kind: 'subscription', id: 's1', error: 'oops' }),
      ),
    ).toEqual({ type: 'error', kind: 'subscription', id: 's1', error: 'oops' })
  })
  test('accepts retryable and threads it through', () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: 'error',
          kind: 'subscription',
          id: 's1',
          retryable: true,
          error: 'oops',
        }),
      ),
    ).toEqual({
      type: 'error',
      kind: 'subscription',
      id: 's1',
      retryable: true,
      error: 'oops',
    })
    expect(
      parseServerMessage(
        JSON.stringify({
          type: 'error',
          kind: 'subscription',
          id: 's2',
          retryable: false,
          error: 'nope',
        }),
      ),
    ).toEqual({
      type: 'error',
      kind: 'subscription',
      id: 's2',
      retryable: false,
      error: 'nope',
    })
  })
  test('rejects non-boolean retryable when present', () => {
    expect(
      parseServerMessage(
        JSON.stringify({ type: 'error', id: 's1', retryable: 'yes', error: 'boom' }),
      ),
    ).toBeNull()
  })
  test('omits kind when it was absent on the wire (backward-compat)', () => {
    const got = parseServerMessage(JSON.stringify({ type: 'error', id: 'c1', error: 'boom' }))
    expect(got).not.toBeNull()
    expect(Object.hasOwn(got as object, 'kind')).toBe(false)
  })
  test('tolerates an unrecognized future kind value as absent', () => {
    const got = parseServerMessage(
      JSON.stringify({ type: 'error', kind: 'unknown', id: 'c1', error: 'boom' }),
    )

    expect(got).toEqual({ type: 'error', id: 'c1', error: 'boom' })
    expect(Object.hasOwn(got as object, 'kind')).toBe(false)
  })
  test('tolerates unknown future kind while preserving retryable', () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          type: 'error',
          kind: 'future-subscription',
          id: 's1',
          retryable: true,
          error: 'boom',
        }),
      ),
    ).toEqual({ type: 'error', id: 's1', retryable: true, error: 'boom' })
  })
})

describe('parseServerMessage — result', () => {
  test('accepts a result with object data', () => {
    expect(
      parseServerMessage(JSON.stringify({ type: 'result', id: 'c1', data: { ok: true } })),
    ).toEqual({ type: 'result', id: 'c1', data: { ok: true } })
  })
  test('accepts a result with null / primitive / array data (data is unknown)', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'result', id: 'c1', data: null }))).toEqual({
      type: 'result',
      id: 'c1',
      data: null,
    })
    expect(parseServerMessage(JSON.stringify({ type: 'result', id: 'c1', data: 42 }))).toEqual({
      type: 'result',
      id: 'c1',
      data: 42,
    })
    expect(parseServerMessage(JSON.stringify({ type: 'result', id: 'c1', data: [1, 2] }))).toEqual({
      type: 'result',
      id: 'c1',
      data: [1, 2],
    })
  })
  test('accepts a result with absent data (undefined)', () => {
    const got = parseServerMessage(JSON.stringify({ type: 'result', id: 'c1' }))
    expect(got).toEqual({ type: 'result', id: 'c1', data: undefined })
  })
  test('rejects missing id', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'result', data: 1 }))).toBeNull()
  })
  test('rejects non-string id', () => {
    expect(parseServerMessage(JSON.stringify({ type: 'result', id: 1, data: 1 }))).toBeNull()
  })
})

// ─── parseEnvelope: lenient shape gate ───────────────────────────────────────

describe('parseEnvelope', () => {
  test('accepts any plain object with a string type, leaving payload unvalidated', () => {
    // Lenient: a missing/non-string token on `auth` and missing `args` on
    // `subscribe` pass — payload validation is the caller's job. This is what
    // lets the server engine coerce an auth token the routes.ts way instead of
    // terminally rejecting the frame (the strict parser would reject these).
    expect(parseEnvelope(JSON.stringify({ type: 'auth' }))).toEqual({ type: 'auth' })
    expect(parseEnvelope(JSON.stringify({ type: 'auth', token: 123 }))).toEqual({
      type: 'auth',
      token: 123,
    })
    expect(parseEnvelope(JSON.stringify({ type: 'anything', foo: 1 }))).toEqual({
      type: 'anything',
      foo: 1,
    })
  })
  test('rejects the same envelope failures as the strict parsers', () => {
    expect(parseEnvelope('not json')).toBeNull()
    expect(parseEnvelope('null')).toBeNull()
    expect(parseEnvelope('42')).toBeNull()
    expect(parseEnvelope('[]')).toBeNull()
    expect(parseEnvelope('{}')).toBeNull() // missing type
    expect(parseEnvelope(JSON.stringify({ type: 1 }))).toBeNull() // non-string type
  })
})

describe('REACTIVITY_NOT_ENABLED', () => {
  test('is the stable error-code string', () => {
    expect(REACTIVITY_NOT_ENABLED).toBe('REACTIVITY_NOT_ENABLED')
  })
})
