// @wystack/server
// Reactive data engine with function registry, subscriptions, and multi-runtime transport

export { query, mutation } from './functions'
export { createWyStack } from './create'
export { applyCommands } from './apply-commands'
export { createRoutes } from './routes'
export { createSubscriptionManager } from './subscriptions'
export { ValidationError } from './validation'
// Engine: `attachEngine` is the consumer entry point. Reactive port types and
// in-process factories are public so external adapters can implement the same
// transport-neutral contracts without importing transport internals.
export {
  attachEngine,
  createInMemorySubscriptionStore,
  createDispatchInvalidationSource,
  createInvalidationRouter,
} from './engine'

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
export type {
  Command,
  CommandResult,
  ApplyResult,
  CommitResult,
  PreviewResult,
  ApplyCommandsOptions,
} from './apply-commands'
export type { Subscription } from './subscriptions'
export type { RouteOptions } from './routes'
// Public engine types expose attach options plus reactive port contracts.
// `ResolveContext`, `AuthOutcome`, `Dispatch`, and `DispatchResult` stay in
// `./engine` for intra-package adapters, not on the npm surface.
export type {
  AttachEngineOptions,
  EngineHandle,
  CloseReason,
  Session,
  SubscriptionEntry,
  SubscriptionStore,
  InvalidationHandler,
  InvalidationSource,
  DispatchInvalidationSource,
  InvalidationRouterOptions,
} from './engine'
