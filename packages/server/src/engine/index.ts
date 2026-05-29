// @wystack/server — Engine barrel
//
// The two-timescale Engine (Spec ADR #8): Session (connection-timescale auth
// gate) + Dispatch (request-timescale RPC), composed onto any `Pipe` by
// `attachEngine`. RPC tier is always on; reactive subscriptions are opt-in.

export { attachEngine, createReactiveTier } from './engine'
export type { AttachEngineOptions, EngineHandle, ReactiveTier } from './engine'
export { Session, buildAuthRequest } from './session'
export type { CloseReason, ResolveContext, AuthOutcome, SessionOptions } from './session'
export { createDispatch } from './dispatch'
export type { Dispatch, DispatchResult } from './dispatch'
