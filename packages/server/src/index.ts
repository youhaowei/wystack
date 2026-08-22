// @wystack/server
// Reactive data engine with function registry, subscriptions, and multi-runtime transport

export { defineApp } from './define-app'
export { createCaller } from './caller'
export { authorize, AuthenticationRequiredError, requireAuth } from './functions'
export { assertPermissionIds } from './permissions'
export { applyCommands } from './apply-commands'
export { createDraftLifecycle, compactLog } from './draft-lifecycle'
export { createRoutes } from './routes'
// mountNodeRoutes is intentionally NOT re-exported here — it lives at the
// `@wystack/server/node` entry (serve-node.ts). Re-exporting it from the root
// would pull node:http/node:events + @hono/node-* into every import of this
// runtime-neutral package, breaking edge runtimes and bundlers that only touch
// defineApp/createRoutes. Import it from '@wystack/server/node'.
export { createSubscriptionManager } from './subscriptions'
export { ValidationError } from './validation'
export { PermissionDeniedError } from '@wystack/permissions'
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
  ActionDef,
  FunctionContext,
  FunctionDef,
  InferArgs,
  InferArg,
  DbInput,
  WyStackServer,
  MiddlewareFn,
  StageOk,
  Overwrite,
} from './types'
export type { CallerFromFunctions } from './caller'
export type { DefineAppOptions, BuildOptions } from './define-app'
export type { ProcedureBuilder } from './functions'
export type { WyStackApp } from './create'
export type {
  Command,
  CommandResult,
  ApplyResult,
  CommitResult,
  PreviewResult,
  ApplyCommandsOptions,
} from './apply-commands'
export type {
  DraftLifecycle,
  DraftCommand,
  ResolveHook,
  ConflictReport,
  VersionProbe,
  Version,
  Cell,
  OpenOptions,
  DraftOperationOptions,
  DraftLifecycleOptions,
  DraftAuthorizationRequest,
} from './draft-lifecycle'
export type { Subscription } from './subscriptions'
export type { RouteOptions } from './routes'
export type { MountedRoutes } from './serve-node'
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
