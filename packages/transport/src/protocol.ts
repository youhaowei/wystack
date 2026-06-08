// @wystack/transport — wire protocol
//
// Typed wire-protocol contract for the WyStack WebSocket transport.
//
// Source of truth: `packages/server/src/routes.ts`. This package is type-only;
// it does NOT change the wire and has no runtime dependencies.
//
// Active vs reserved:
//   - The active discriminated unions (ClientMessage / ServerMessage) cover
//     every message kind sent on the wire today, including the RPC pair
//     (`call` / `result`) added by the Engine extraction.
//   - `NextMessage` and `ResyncMessage` are typed but excluded from the active
//     unions. They are reserved for the post-v0.2 incremental push profile.
//
// Discriminator: the wire field is `type` (string). The TypeScript type names
// end in `Message` (AuthMessage, SubscribeMessage, ...) but that suffix is not
// part of the wire — only the `type` value is.
//
// Two parse layers, manual and dependency-free:
//   - `parseEnvelope` is the LENIENT shape gate — it mirrors the server's
//     pre-dispatch parser at `routes.ts:135` exactly (non-object → null,
//     missing/non-string `type` → null) and stops there. Server adapters route
//     on `type` first, then validate payload fields per-handler — the shipped
//     server's `auth` token coercion and `args ?? {}` defaulting live in the
//     handlers, not the parser.
//   - `parseClientMessage` / `parseServerMessage` are STRICTER than the shipped
//     server: on top of the envelope they enforce per-kind required fields,
//     INCLUDING ones the shipped handlers tolerate — a missing or non-string
//     `token` on `auth`, and a missing/non-object `args` on `subscribe`/`call`.
//     Those are deliberate tightenings, safe because the typed client always
//     sends well-formed frames. Callers that need shipped-server leniency (the
//     engine's auth path) route through `parseEnvelope` + handler coercion, not
//     the strict parser. Unknown `type`, missing required fields, and wrong
//     field types all return `null`.

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
 * RPC call over message transports (IPC, loopback). One unified kind for both
 * queries and mutations — the server's function registry resolves which `path`
 * is. HTTP keeps REST verbs; this kind is for transports that have no verb to
 * carry intent. The connection's token is captured at `auth`
 * time and reused, so there is no `token` field here.
 */
export interface CallMessage {
  type: 'call'
  id: string
  path: string
  args: Record<string, unknown>
}

export type ClientMessage = AuthMessage | SubscribeMessage | UnsubscribeMessage | CallMessage

// ─── Server → Client (active) ────────────────────────────────────────────────

/**
 * Ack for a successful auth handshake. Wire value is `"authenticated"`;
 * a later protocol version may rename this to `"auth-ack"`.
 */
export interface AuthenticatedMessage {
  type: 'authenticated'
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
 * `kind` tags the origin of a request-scoped error so the client can
 * route it correctly without inspecting the `id` string:
 *   - `'call'`         — a `call` frame's handler failed or could not run.
 *   - `'subscription'` — a `subscribe` frame was rejected.
 *   - absent           — connection-level error (no `id`), or an older
 *                        server that has not yet set the discriminant
 *                        (backward-compatible: treat as `'call'` when `id`
 *                        is present).
 *
 * `retryable` tags whether a subscription-origin error should stay registered
 * for reconnect replay. Absent is backward-compatible durable behavior.
 *
 * `issues` carries Zod validation issues when the server's
 * `ValidationError` surfaces — typed as `unknown[]` here to keep the
 * protocol package free of a Zod dependency.
 */
export interface ErrorMessage {
  type: 'error'
  id?: string
  kind?: 'call' | 'subscription'
  retryable?: boolean
  error: string
  issues?: unknown[]
}

/**
 * Response to a `call` message. `data` is the function's return value (the
 * registry resolved query vs mutation; the wire does not distinguish). Errors
 * surface as an `ErrorMessage` carrying the same `id`, not a `result`.
 */
export interface ResultMessage {
  type: 'result'
  id: string
  data: unknown
}

export type ServerMessage =
  | AuthenticatedMessage
  | SubscribedMessage
  | InvalidateMessage
  | ResultMessage
  | ErrorMessage

// ─── Error codes ──────────────────────────────────────────────────────────

/**
 * Sentinel `error` string returned to any `subscribe` on a server that has not
 * wired the reactive tier. The
 * v0.2 capability-discovery floor: a client learns the tier is absent from this
 * error rather than from wire-protocol version negotiation (deferred).
 */
export const REACTIVITY_NOT_ENABLED = 'REACTIVITY_NOT_ENABLED'

// ─── Reserved (post-v0.2 push profile — NOT in active unions) ────────────────

/**
 * RESERVED — post-v0.2 incremental push. Carries either a
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
 * A frame that passed the lenient envelope check: a plain object with a
 * `string` `type`. Other fields are unknown-keyed for per-kind narrowing. This
 * is the shape `parseEnvelope` guarantees — the discriminant is known, payload
 * fields are not yet validated.
 */
export type Envelope = { type: string } & Record<string, unknown>

/**
 * Lenient shape check: parse JSON, require a plain object with a `string`
 * `type` field. Returns the envelope for per-kind narrowing, or `null` for any
 * structural rejection. Mirrors the server's pre-dispatch parser at
 * `routes.ts:135`.
 *
 * This is the LENIENT counterpart to `parseClientMessage`: it gates only the
 * frame `type` and leaves payload-field validation to the caller. Server
 * adapters route on `type` first (e.g. `auth` token coercion is the Session's
 * job, not the parser's — gating it strictly would reject frames the shipped
 * server accepts), then strict-parse the payload of post-auth frames. Exported
 * so the engine performs the same envelope-then-strict split routes.ts does.
 */
export function parseEnvelope(data: string): Envelope | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const msg = parsed as Record<string, unknown>
  if (typeof msg.type !== 'string') return null
  return msg as Envelope
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

type ServerMessageParser = (msg: Envelope) => ServerMessage | null

const parseServerMessageByType: Record<string, ServerMessageParser> = {
  authenticated: () => ({ type: 'authenticated' }),
  subscribed: (msg) => {
    if (typeof msg.id !== 'string') return null
    return { type: 'subscribed', id: msg.id }
  },
  invalidate: (msg) => {
    if (typeof msg.id !== 'string') return null
    return { type: 'invalidate', id: msg.id }
  },
  result: (msg) => {
    if (typeof msg.id !== 'string') return null
    return { type: 'result', id: msg.id, data: msg.data }
  },
  error: (msg) => {
    if (typeof msg.error !== 'string') return null
    if (msg.id !== undefined && typeof msg.id !== 'string') return null
    if (msg.issues !== undefined && !Array.isArray(msg.issues)) return null
    if (msg.retryable !== undefined && typeof msg.retryable !== 'boolean') return null

    const out: ErrorMessage = { type: 'error', error: msg.error }
    if (typeof msg.id === 'string') out.id = msg.id
    if (msg.kind === 'call' || msg.kind === 'subscription') out.kind = msg.kind
    if (typeof msg.retryable === 'boolean') out.retryable = msg.retryable
    if (Array.isArray(msg.issues)) out.issues = msg.issues
    return out
  },
}

/**
 * Strict parse for a Server → Client frame. Returns the typed message on
 * success, `null` for any rejection. Symmetry with `parseClientMessage` —
 * unknown discriminants and missing required fields both return null.
 */
export function parseServerMessage(data: string): ServerMessage | null {
  const msg = parseEnvelope(data)
  if (msg === null) return null

  return parseServerMessageByType[msg.type]?.(msg) ?? null
}
