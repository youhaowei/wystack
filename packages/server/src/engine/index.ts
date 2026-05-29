// @wystack/server — Engine barrel
//
// The two-timescale Engine (Spec ADR #8): Session (connection-timescale auth
// gate) + Dispatch (request-timescale pure RPC), composed onto any `Pipe` by
// `attachEngine`. RPC tier always on; reactive tier opt-in (YW-62).

export { attachEngine } from './engine'
export type { AttachEngineOptions, EngineHandle } from './engine'
export { Session, buildAuthRequest } from './session'
export type { CloseReason, ResolveContext, AuthOutcome, SessionOptions } from './session'
export { createDispatch } from './dispatch'
export type { Dispatch, DispatchResult } from './dispatch'
