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
export { createClientEngine } from './engine'
export { createWsManager } from './ws'

export type { WyStackClient } from './client'
export type {
  ClientEngine,
  ClientEngineConfig,
  ClientEnginePipe,
  ClientEngineCloseEvent,
} from './engine'
export type { WsManager, WsManagerConfig } from './ws'
export type { WyStackClientConfig } from './types'
