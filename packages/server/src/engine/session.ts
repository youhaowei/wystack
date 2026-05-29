// @wystack/server — Session (connection-timescale)
//
// Session is the connection-timescale half of the Engine (Spec ADR #8). It owns
// everything that lives for the duration of one connection: the authenticated
// gate, the captured auth token, the handshake timeout, and teardown. It does
// NOT own sockets or close codes — it runs over any `Pipe`, and emits a
// transport-neutral `CloseReason` that the adapter maps to a wire close (the
// Hono WS adapter maps `auth-failed → 4001`, `transient → 4002`; YW-57).
//
// Auth parity with the shipped `routes.ts` handshake is the contract (AC #2).
// The non-obvious behaviors preserved here:
//   - idempotent ACK when already authenticated (no-auth server OR repeat
//     frame) — never adopts/overwrites the token;
//   - double-auth-frame race: `token` is committed only after winning the
//     post-await re-check, so the slower frame cannot swap the winning identity;
//   - anonymous (`token: null`) strips any inherited Authorization header before
//     `resolveContext` runs, so the auth frame is the sole identity source;
//   - the synthetic Bearer `Request` is rebuilt per resolve so adapters see a
//     fresh identity (no cross-call mutation).
//
// Duplicated from `routes.ts` on purpose: YW-56 is additive (the Engine sits
// beside the live routes). YW-57 rewires `routes.ts` through this Session and
// removes the duplication. Editing `routes.ts` here is out of scope.

/**
 * Transport-neutral reason a Session asks the connection to close. The adapter
 * maps it to a wire-level code:
 *   - `auth-failed` — terminal. Bad/missing token, non-auth first frame, or a
 *     protocol violation. The client must NOT retry (WS 4001).
 *   - `transient` — recoverable. Handshake timed out, or the ack send failed
 *     after auth succeeded. The client retries with backoff (WS 4002).
 */
export type CloseReason = 'auth-failed' | 'transient'

/**
 * Resolves a connection's auth context from a synthetic `Request`. Same shape
 * as the shipped `RouteOptions.resolveContext` — `Request` is a Fetch standard,
 * not HTTP-server-specific, so it carries cleanly over any Pipe. The Session
 * synthesizes the Request from the auth-frame token via `buildAuthRequest`.
 */
export type ResolveContext = (req: Request) => Promise<Record<string, unknown>>

/**
 * Build the synthetic `Request` passed to `resolveContext`.
 *
 * Non-empty string `token` → layer `Authorization: Bearer ${token}` over the
 * connection's base headers. `null` (anonymous) → strip any inherited
 * Authorization so the auth frame is the sole identity source — a null-token
 * client cannot silently inherit an identity leaked via cookie proxy, reverse
 * proxy, or stale query handoff. Mirrors `routes.ts:buildAuthRequest`.
 *
 * `base` is the connection's origin request (cookies, forwarded headers, URL).
 * Pipe-based transports with no HTTP origin pass a minimal `Request` (e.g.
 * `new Request('wystack://pipe')`); the URL is opaque to `resolveContext`.
 */
export function buildAuthRequest(base: Request, token: string | null): Request {
  const headers = new Headers(base.headers)
  if (token !== null && token.length > 0) {
    headers.set('authorization', `Bearer ${token}`)
  } else {
    headers.delete('authorization')
  }
  return new Request(base.url, { method: base.method, headers })
}

/**
 * Outcome of feeding an `auth` frame to the Session. The Engine acts on it:
 *   - `authenticated` — send `{ type: 'authenticated' }`. Reached on a
 *     successful handshake AND on the idempotent-ACK path (already
 *     authenticated). `committed` is true only when this frame is the one that
 *     transitioned the connection (won the race); false on idempotent ACKs.
 *   - `close` — tear the connection down with `reason`. The Engine has not yet
 *     sent anything; it closes the pipe and maps `reason` to a wire code.
 */
export type AuthOutcome =
  | { kind: 'authenticated'; committed: boolean }
  | { kind: 'close'; reason: CloseReason }

export interface SessionOptions {
  /**
   * When provided, the connection requires a successful auth handshake before
   * any `call`/`subscribe` is accepted. When omitted, the connection starts
   * authenticated (trusted transport — in-process IPC, loopback) and an `auth`
   * frame gets a compatibility ACK without adopting any token.
   */
  resolveContext?: ResolveContext
  /**
   * Origin request for `buildAuthRequest` to layer the Bearer header onto.
   * HTTP/WS adapters pass the upgrade request; trusted message transports pass
   * a synthetic placeholder. Defaults to an opaque `wystack://pipe` Request.
   */
  baseRequest?: Request
}

const PIPE_ORIGIN = 'wystack://pipe'

/**
 * Per-connection auth state machine. One Session per Pipe. Holds the gate, the
 * captured token, and the resolve hook. Transport-agnostic: it neither opens
 * nor closes the channel, it only decides outcomes.
 */
export class Session {
  /** True once the handshake has completed (or immediately, on a no-auth server). */
  authenticated: boolean
  /**
   * The token captured from the winning `auth` frame, reused by every
   * `resolveSubContext` for the connection's lifetime. A null base means
   * anonymous. Only written after winning the post-await race (see `handleAuth`).
   */
  token: string | null = null

  private readonly resolveContext: ResolveContext
  private readonly baseRequest: Request

  /** True when this server demands a handshake before accepting other frames. */
  readonly requiresAuth: boolean

  constructor(opts: SessionOptions = {}) {
    this.requiresAuth = opts.resolveContext !== undefined
    this.resolveContext = opts.resolveContext ?? (async () => ({}))
    this.baseRequest = opts.baseRequest ?? new Request(PIPE_ORIGIN)
    this.authenticated = !this.requiresAuth
  }

  /**
   * Resolve a fresh context for a request on this connection, layering the
   * connection's captured token onto a freshly built synthetic Request. Called
   * per request — RPC `call` today (the reactive `subscribe` path lands in
   * YW-62, which reuses this same method). The Bearer/anonymous invariants live
   * in `buildAuthRequest`. The `Sub` in the name is "sub-context", not
   * "subscribe" — it mirrors the shipped `routes.ts:resolveSubContext`.
   */
  async resolveSubContext(): Promise<Record<string, unknown>> {
    const req = buildAuthRequest(this.baseRequest, this.token)
    return (await this.resolveContext(req)) ?? {}
  }

  /**
   * Feed an `auth` frame. Two paths mirror the shipped handshake:
   *
   *   1. Already authenticated (no-auth server OR a repeat frame) → idempotent
   *      ACK. Never adopts the token — trusted transports rely on connection
   *      trust, not WS credentials; a repeat frame must not swap identity.
   *   2. Unauthenticated → run `resolveContext` with the synthetic Bearer
   *      Request. On success, re-check the gate (a concurrent frame may have
   *      won during the await) and commit the token only if we won. On failure,
   *      close `auth-failed`.
   *
   * The Engine, not the Session, sends frames and closes the pipe — this method
   * is pure decision-making over the `AuthOutcome` it returns.
   */
  async handleAuth(rawToken: unknown): Promise<AuthOutcome> {
    if (this.authenticated) {
      return { kind: 'authenticated', committed: false }
    }

    // Normalize locally — do NOT write `this.token` yet. Two concurrent auth
    // frames can both pass the pre-await `authenticated === false` check;
    // committing here would let the slower frame overwrite the winner's token
    // before it is read. Commit only after winning the post-await re-check.
    const token = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null

    try {
      const req = buildAuthRequest(this.baseRequest, token)
      await this.resolveContext(req)
    } catch {
      // Auth failed — terminal. The Engine logs (with the message only, to
      // avoid leaking token/header values embedded in thrown errors) and closes.
      return { kind: 'close', reason: 'auth-failed' }
    }

    // Re-check after the await: a concurrent frame may have authenticated the
    // connection. The slower frame sends an idempotent ACK and must NOT
    // overwrite the winning identity's token.
    if (this.authenticated) {
      return { kind: 'authenticated', committed: false }
    }

    this.token = token
    this.authenticated = true
    return { kind: 'authenticated', committed: true }
  }
}
