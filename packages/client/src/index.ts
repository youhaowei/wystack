// @wystack/client
// Typed reactive client for WyStack

// Primary API — one-line setup
export { createWyStack } from './setup'
export type { WyStackInstance } from './setup'

// Standalone hooks — Convex-style
export { useQuery, useMutation } from './hooks'
export type { QueryConfig } from './hooks'

// Function reference types
export type {
  QueryRef,
  MutationRef,
  FunctionRef,
  ApiFromFunctions,
  RefArgs,
  RefReturn,
} from './refs'

// Api builder (advanced — usually called via createWyStack)
export { createApi } from './api'

// Low-level client (advanced)
export { createClient } from './client'
export { WyStackProvider, useWyStackClient } from './provider'
export { createWsManager } from './ws'
// Browser WebSocket transport adapter (relocated to ./transport/websocket)
export { createWebSocketPipe } from './transport/websocket'
// Electron IPC transport adapter (T6)
export { createElectronPipe, createIpcManager } from './transport/electron'
export { createEngine, CallNotReadyError } from './engine'

export type { WyStackClient } from './client'
export type { WsManager, WsManagerConfig } from './ws'
export type { IpcManager, IpcManagerConfig, IpcRendererLike } from './transport/electron'
export type { WyStackClientConfig } from './types'
export type {
  Engine,
  EngineConfig,
  EnginePipe,
  PipeFactory,
  CloseInfo,
  SubscriptionErrorHandler,
} from './engine'
