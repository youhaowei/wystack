// @wystack/server — Engine barrel
//
// The two-timescale Engine (Spec ADR #8): Session (connection-timescale auth
// gate) + Dispatch (request-timescale pure RPC), composed onto any `Pipe` by
// `attachEngine`. RPC tier always on; reactive tier opt-in.
//
// Reactive ports live here as the transport/process boundary: SubscriptionStore
// owns active read-tag state plus delivery callbacks; InvalidationSource owns
// write-tag events from dispatch or an external serialized channel.

export { attachEngine } from './engine'
export type { AttachEngineOptions, EngineHandle } from './engine'
export { Session, buildAuthRequest } from './session'
export type { CloseReason, ResolveContext, AuthOutcome, SessionOptions } from './session'
export { createDispatch } from './dispatch'
export type { Dispatch, DispatchResult } from './dispatch'
export { createInMemorySubscriptionStore } from './subscription-store'
export type { SubscriptionEntry, SubscriptionStore } from './subscription-store'
export { createDispatchInvalidationSource } from './invalidation-source'
export type {
  DispatchInvalidationSource,
  InvalidationHandler,
  InvalidationSource,
} from './invalidation-source'
