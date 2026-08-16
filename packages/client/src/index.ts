// @wystack/client
// Typed reactive client for WyStack

// Primary API — one-line setup
export { createWyStack } from './setup.js'
export type { WyStackInstance } from './setup.js'

// Transport-neutral React composition
export { createReactBindings } from './bindings.js'
export type { CreateReactBindingsOptions, WyStackReactBindings } from './bindings.js'

// Standalone hooks — Convex-style
export { useQuery, useMutation, useAction } from './hooks.js'
export type { QueryConfig } from './hooks.js'

// Function reference types
export type {
  QueryRef,
  MutationRef,
  ActionRef,
  FunctionRef,
  ApiFromFunctions,
  FunctionDefinition,
  RefArgs,
  RefReturn,
} from './refs.js'

// Api builder (advanced — usually called via createWyStack)
export { createApi } from './api.js'

// Low-level client (advanced)
export { createClient } from './client.js'
export { WyStackProvider, useWyStackClient } from './provider.js'
export { createWsManager } from './ws.js'
// Browser WebSocket transport adapter (relocated to ./transport/websocket)
export { createWebSocketPipe } from './transport/websocket.js'
// Electron IPC transport adapter (T6)
export { createElectronPipe, createIpcManager } from './transport/electron.js'
export { createEngine, CallNotReadyError } from './engine.js'

export type { WebClient, WyStackClient } from './client.js'
export type { Client, ActionOptions, LiveUpdatesErrorHandler } from './core-client.js'
export type { WsManager, WsManagerConfig } from './ws.js'
export type { IpcManager, IpcManagerConfig, IpcRendererLike } from './transport/electron.js'
export type { WyStackClientConfig } from './types.js'
export type {
  Engine,
  EngineConfig,
  EnginePipe,
  PipeFactory,
  CloseInfo,
  SubscriptionErrorHandler,
} from './engine.js'
