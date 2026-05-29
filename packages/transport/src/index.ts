// @wystack/transport
//
// Transport substrate. Two surfaces in one package, deliberately co-located
// so the wire format and the per-connection channel that carries it live
// next to each other (Spec ADR #8 — four-layer transport).
//
//   1. Per-connection channel: `Pipe<In, Out>` interface (`./pipe`), the
//      in-memory loopback adapter `createLoopbackPair` (`./loopback`), and
//      `wrapTypedPipe` (`./typed`) for lifting a raw `Pipe` to a parsed,
//      compile-time-typed view.
//
//   2. Typed wire-protocol contract for the WyStack WebSocket transport
//      (`./protocol`). Active discriminated unions (`ClientMessage`,
//      `ServerMessage`) — including the RPC pair `call`/`result` — reserved
//      post-v0.2 kinds, the `REACTIVITY_NOT_ENABLED` error code, and strict
//      manual parsers. Source of truth: `packages/server/src/routes.ts`.
//
// This barrel re-exports the full public surface — consumers should import
// from `@wystack/transport`, not the internal modules.

export type { Pipe } from './pipe'
export { createLoopbackPair } from './loopback'
export { wrapTypedPipe } from './typed'

export type {
  // Active client → server
  AuthMessage,
  SubscribeMessage,
  UnsubscribeMessage,
  CallMessage,
  ClientMessage,
  // Active server → client
  AuthenticatedMessage,
  SubscribedMessage,
  InvalidateMessage,
  ResultMessage,
  ErrorMessage,
  ServerMessage,
  // Reserved post-v0.2
  NextMessage,
  ResyncMessage,
  // Envelope (lenient shape gate)
  Envelope,
} from './protocol'
export {
  parseClientMessage,
  parseServerMessage,
  parseEnvelope,
  REACTIVITY_NOT_ENABLED,
} from './protocol'
