// @wystack/transport — per-connection channel
//
// `Pipe<In, Out>` is the per-connection transport adapter — layer 2 in Spec
// ADR #8 (four-layer transport: process boundary → channel → wire protocol →
// engine). Adapters land beneath this interface: in-memory loopback for tests
// today, WebSocket and Electron IPC next.
//
// Generic by default. The transport substrate itself does not know what
// flows through a pipe — concrete typed pipes are built on top by
// `wrapTypedPipe` once a parser is in scope.

/**
 * Per-connection transport channel. Implementations include the in-memory
 * loopback (`createLoopbackPair`), the WebSocket adapter (T2b/T3b), and the
 * Electron IPC adapter (T5/T6).
 *
 *   - `id` — stable per-connection identifier for diagnostics and correlation.
 *   - `send(message)` — outbound delivery. May be sync or async; callers do
 *     not need to await but may.
 *   - `onMessage(handler)` — register an inbound handler. Returns an
 *     unsubscribe function that removes that specific handler. Multiple
 *     handlers may be registered on the same pipe; each receives every
 *     inbound message.
 *   - `close()` — terminate the channel. Idempotent (a second `close` is a
 *     no-op, never throws). After close, `send` is a silent no-op and
 *     `onMessage` returns a no-op unsubscribe.
 *
 * The interface defaults to `unknown` so consumers that do not care about
 * message shape (session registries, logging middleware, the loopback used
 * for malformed-input tests) hold a plain `Pipe` without generic noise.
 */
export interface Pipe<In = unknown, Out = unknown> {
  readonly id: string
  send(message: Out): void | Promise<void>
  /**
   * Register an inbound handler. Returns an unsubscribe function — calling
   * it removes that specific handler and is itself idempotent.
   */
  onMessage(handler: (message: In) => void): () => void
  close(): void | Promise<void>
}
