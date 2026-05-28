// @wystack/transport — wire protocol
//
// Typed wire-protocol contract for the WyStack WebSocket transport.
//
// Source of truth: `packages/server/src/routes.ts` (the live v0.2 wire shipped
// by TASK-489 — WebSocket auth handshake). This package is type-only; it does
// NOT change the wire and has no runtime dependencies.
//
// Active vs reserved:
//   - The active discriminated unions (ClientMessage / ServerMessage) cover
//     every message kind sent on the wire today.
//   - `NextMessage` and `ResyncMessage` are typed but excluded from the active
//     unions. They are reserved for the post-v0.2 incremental push profile
//     (Spec ADR #10 — signal-first reactive delivery). Defining them here lets
//     the push profile land cleanly later without relocating types.
//
// Discriminator: the wire field is `type` (string). The TypeScript type names
// end in `Message` (AuthMessage, SubscribeMessage, ...) but that suffix is not
// part of the wire — only the `type` value is.
//
// Parsers are manual discriminated-union parses with no runtime deps. They
// mirror the shape rejection done by the existing server-side parser at
// `packages/server/src/routes.ts:130` (non-object → null, missing/non-string
// `type` → null) and additionally enforce per-kind required fields. Unknown
// `type` values, missing required fields, and wrong field types all return
// `null` — callers pick the close code or error-frame policy.

// ─── Client → Server (active) ────────────────────────────────────────────────

/**
 * First frame on a connection when the server is configured with
 * `resolveContext`. `token` is `string | null` — null means anonymous
 * (any leaked Authorization header is stripped by the server before
 * `resolveContext` runs).
 */
export interface AuthMessage {
  type: 'auth'
  token: string | null
}

/**
 * Start a reactive subscription. `path` is the function registry key (e.g.
 * `"users.list"`); `args` is the function input. The connection's token is
 * captured at `auth` time and reused for every subscribe — there is no
 * `token` field on this message.
 */
export interface SubscribeMessage {
  type: 'subscribe'
  id: string
  path: string
  args: Record<string, unknown>
}

/**
 * Cancel a subscription (active or in-flight). The server tolerates unknown
 * IDs silently — they may refer to a sub that was already torn down on the
 * server side.
 */
export interface UnsubscribeMessage {
  type: 'unsubscribe'
  id: string
}

/**
 * Unified RPC verb (query or mutation). `path` is the function registry key;
 * `args` is the function input. The connection's resolved context from `auth`
 * is applied server-side — there is no `token` field on this message.
 */
export interface CallMessage {
  type: 'call'
  id: string
  path: string
  args: Record<string, unknown>
}

export type ClientMessage =
  | AuthMessage
  | CallMessage
  | SubscribeMessage
  | UnsubscribeMessage

// ─── Server → Client (active) ────────────────────────────────────────────────

/**
 * Ack for a successful auth handshake. Wire value is `"authenticated"`
 * (historical — the Spec proposes `"auth-ack"` for v0.3; T2b/T3a may rename).
 */
export interface AuthenticatedMessage {
  type: 'authenticated'
}

/**
 * RPC success. `data` is the handler return value (query result or mutation
 * output). Delivered in response to a `call` frame with the same `id`.
 */
export interface ResultMessage {
  type: 'result'
  id: string
  data: unknown
}

/**
 * Ack that a subscription has been registered and is now eligible for
 * `invalidate` frames. The initial value is delivered out-of-band over HTTP
 * by the client's reactive query layer, not on this frame.
 */
export interface SubscribedMessage {
  type: 'subscribed'
  id: string
}

/**
 * The named subscription's tablesWatched set was touched by a mutation —
 * the client should refetch. Carries only the sub `id`; no payload diff in
 * v0.2 (see `NextMessage` below for the post-v0.2 push profile).
 */
export interface InvalidateMessage {
  type: 'invalidate'
  id: string
}

/**
 * Generic error frame. `id` is present when the error is scoped to a
 * specific in-flight request (subscribe/unsubscribe), absent for
 * connection-level errors (malformed frame, unknown type, etc.).
 *
 * `issues` carries Zod validation issues when the server's
 * `ValidationError` surfaces — typed as `unknown[]` here to keep the
 * protocol package free of a Zod dependency. T2b can thread the
 * concrete shape through if it stays stable.
 */
export interface ErrorMessage {
  type: 'error'
  id?: string
  error: string
  issues?: unknown[]
}

export type ServerMessage =
  | AuthenticatedMessage
  | ResultMessage
  | SubscribedMessage
  | InvalidateMessage
  | ErrorMessage

/** Typed error when `subscribe` arrives but the reactive tier is not wired. */
export const REACTIVITY_NOT_ENABLED = 'REACTIVITY_NOT_ENABLED'

// ─── Reserved (post-v0.2 push profile — NOT in active unions) ────────────────

/**
 * RESERVED — post-v0.2 incremental push (Spec ADR #10). Carries either a
 * full `value` snapshot or a `delta` patch, versioned monotonically per sub
 * so the client can detect gaps and request a resync. Not on the active
 * wire today; exported for forward-compatibility only.
 */
export interface NextMessage {
  type: 'next'
  id: string
  version: number
  value?: unknown
  delta?: unknown
}

/**
 * RESERVED — post-v0.2 trigger from the server (or client request) to
 * re-baseline a subscription that has fallen out of sync. Not on the
 * active wire today.
 */
export interface ResyncMessage {
  type: 'resync'
  id: string
}

// ─── Parsers (manual, no runtime deps) ───────────────────────────────────────

/**
 * Shared shape check: parse JSON, require a plain object with a `string`
 * `type` field. Returns the unknown-keyed record for per-kind narrowing,
 * or `null` for any structural rejection. Mirrors the existing server
 * parser at `packages/server/src/routes.ts:130`.
 */
function parseEnvelope(data: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const msg = parsed as Record<string, unknown>
  if (typeof msg.type !== 'string') return null
  return msg
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Strict parse for a Client → Server frame. Returns the typed message on
 * success, `null` for any rejection (unparseable JSON, non-object, unknown
 * `type`, missing required field, wrong field type).
 *
 * This is strictly stricter than the server's pre-dispatch parser — the
 * server admits any string `type` and validates per-handler. This parser
 * rejects unknown discriminants up front, which is the contract clients
 * and tests want.
 */
export function parseClientMessage(data: string): ClientMessage | null {
  const msg = parseEnvelope(data)
  if (msg === null) return null

  switch (msg.type) {
    case 'auth': {
      // token is `string | null` on the wire; the server coerces missing /
      // empty / non-string to `null` (routes.ts:243). The parser is the strict
      // counterpart: require the field, require the type. Callers that want
      // server-style leniency should pre-normalize.
      if (msg.token !== null && typeof msg.token !== 'string') return null
      return { type: 'auth', token: msg.token }
    }
    case 'subscribe': {
      if (typeof msg.id !== 'string') return null
      if (typeof msg.path !== 'string') return null
      if (!isPlainObject(msg.args)) return null
      return { type: 'subscribe', id: msg.id, path: msg.path, args: msg.args }
    }
    case 'unsubscribe': {
      if (typeof msg.id !== 'string') return null
      return { type: 'unsubscribe', id: msg.id }
    }
    case 'call': {
      if (typeof msg.id !== 'string') return null
      if (typeof msg.path !== 'string') return null
      if (!isPlainObject(msg.args)) return null
      return { type: 'call', id: msg.id, path: msg.path, args: msg.args }
    }
    default:
      return null
  }
}

/**
 * Strict parse for a Server → Client frame. Returns the typed message on
 * success, `null` for any rejection. Symmetry with `parseClientMessage` —
 * unknown discriminants and missing required fields both return null.
 */
export function parseServerMessage(data: string): ServerMessage | null {
  const msg = parseEnvelope(data)
  if (msg === null) return null

  switch (msg.type) {
    case 'authenticated': {
      return { type: 'authenticated' }
    }
    case 'result': {
      if (typeof msg.id !== 'string') return null
      if (!('data' in msg)) return null
      return { type: 'result', id: msg.id, data: msg.data }
    }
    case 'subscribed': {
      if (typeof msg.id !== 'string') return null
      return { type: 'subscribed', id: msg.id }
    }
    case 'invalidate': {
      if (typeof msg.id !== 'string') return null
      return { type: 'invalidate', id: msg.id }
    }
    case 'error': {
      if (typeof msg.error !== 'string') return null
      // `id` is optional. If present, must be a string. Missing is fine.
      if (msg.id !== undefined && typeof msg.id !== 'string') return null
      // `issues` is optional. If present, must be an array. Element shape is
      // intentionally `unknown` here (see ErrorMessage doc).
      if (msg.issues !== undefined && !Array.isArray(msg.issues)) return null
      const out: ErrorMessage = { type: 'error', error: msg.error }
      if (typeof msg.id === 'string') out.id = msg.id
      if (Array.isArray(msg.issues)) out.issues = msg.issues
      return out
    }
    default:
      return null
  }
}
