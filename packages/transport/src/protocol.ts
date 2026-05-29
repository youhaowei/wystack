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
//     every message kind sent on the wire today, including the RPC pair
//     (`call` / `result`) added by the Engine extraction (Spec ADR #9, #12).
//   - `NextMessage` and `ResyncMessage` are typed but excluded from the active
//     unions. They are reserved for the post-v0.2 incremental push profile
//     (Spec ADR #10 — signal-first reactive delivery). Defining them here lets
//     the push profile land cleanly later without relocating types.
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
 * is (Spec ADR #9). HTTP keeps REST verbs; this kind is for transports that
 * have no verb to carry intent. The connection's token is captured at `auth`
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
 * Ack for a successful auth handshake. Wire value is `"authenticated"`
 * (historical — the Spec proposes `"auth-ack"` for v0.3; T2b/T3a may rename).
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
 * wired the reactive tier (Spec ADR #12 — RPC always-on, reactive opt-in). The
 * v0.2 capability-discovery floor: a client learns the tier is absent from this
 * error rather than from wire-protocol version negotiation (deferred).
 */
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
    case 'subscribed': {
      if (typeof msg.id !== 'string') return null
      return { type: 'subscribed', id: msg.id }
    }
    case 'invalidate': {
      if (typeof msg.id !== 'string') return null
      return { type: 'invalidate', id: msg.id }
    }
    case 'result': {
      // `data` is `unknown` by design — the function's return value carries no
      // wire-level shape contract. Only `id` is structurally required.
      if (typeof msg.id !== 'string') return null
      return { type: 'result', id: msg.id, data: msg.data }
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
