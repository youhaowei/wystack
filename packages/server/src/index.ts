// @wystack/server
// Reactive data engine with function registry, subscriptions, and multi-runtime transport

export { query, mutation } from './functions'
export { createWyStack } from './create'
export { createRoutes } from './routes'
export { attachEngine, createDispatch, buildAuthRequest, createSession } from './engine'
export { createSubscriptionManager } from './subscriptions'
export { ValidationError } from './validation'

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
export type { EngineOptions, DispatchFn, DispatchResult, Session, SessionOptions } from './engine'
export type { Subscription } from './subscriptions'
export type { RouteOptions } from './routes'
