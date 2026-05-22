// @wystack/server
// Reactive data engine with function registry, subscriptions, and multi-runtime transport

export { query, mutation } from './functions'
export { createWyStack } from './create'
export { createRoutes } from './routes'
export { createSubscriptionManager } from './subscriptions'
export { ValidationError } from './validation'
export {
  attachTransportDispatcher,
  createLoopbackPair,
  isJsonValue,
  isRecord,
  parseClientMessage,
} from './transport'

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
export type {
  ClientTransportMessage,
  JsonPrimitive,
  JsonValue,
  ServerTransportMessage,
  TransportDispatcher,
  TransportEndpoint,
  TransportErrorMessage,
  TransportInvalidateMessage,
  TransportMessage,
  TransportMessageHandler,
  TransportProcedure,
  TransportProcedureContext,
  TransportProcedureResult,
  TransportRegistry,
  TransportRequestMessage,
  TransportRequestType,
  TransportResultMessage,
  TransportSubscribedMessage,
  TransportUnsubscribeMessage,
} from './transport'
