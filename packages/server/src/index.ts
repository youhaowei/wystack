// @wystack/server
// Reactive data engine with function registry, subscriptions, and multi-runtime transport

export { query, mutation } from './functions'
export { createWyStack } from './create'
export { createRoutes } from './routes'
export { createSubscriptionManager } from './subscriptions'
export { ValidationError } from './validation'
// Engine: only `attachEngine` is a consumer entry point. `Session`,
// `createDispatch`, and the internal types stay in the intra-package
// `./engine` barrel for the adapters YW-57 builds on top — not the public
// surface, so YW-57/62 refactors don't become breaking changes.
export { attachEngine } from './engine'

export type {
  QueryDef,
  MutationDef,
  FunctionContext,
  FunctionDef,
  InferArgs,
  InferArg,
  DbInput,
  WyStackServer,
} from './types'
export type { WyStackApp } from './create'
export type { Subscription } from './subscriptions'
export type { RouteOptions } from './routes'
// Public engine surface = what `attachEngine`'s signature transitively needs.
// `ResolveContext`, `AuthOutcome`, `Dispatch`, `DispatchResult` are internal —
// they live in `./engine` for intra-package adapters, not on the npm surface.
export type { AttachEngineOptions, EngineHandle, CloseReason, Session } from './engine'
