import type { UpgradeWebSocket, WSContext } from 'hono/ws'
import type { WyStackApp } from '../create'

export interface RouteOptions {
  app: WyStackApp
  /** URL prefix for all routes. Default: '/api' */
  prefix?: string
  resolveContext?: (req: Request) => Promise<Record<string, unknown>>
  /**
   * Max ms to wait for the WS auth handshake message after connect.
   * Only applies when `resolveContext` is configured. Default: 10_000.
   */
  authTimeoutMs?: number
}

/**
 * Per-connection state, keyed by the platform socket (`ws.raw`). Hono creates
 * a new `WSContext` per event callback, so its identity is not stable.
 */
export interface Connection {
  authenticated: boolean
  /**
   * Captured once from the client's auth frame and reused by every subsequent
   * `resolveSubContext` call for the lifetime of this connection.
   */
  token: string | null
  upgradeRequest: Request
  timeout: ReturnType<typeof setTimeout> | null
  subIds: Set<string>
  /**
   * Subscribe IDs whose `resolveContext` / `app.call` is in-flight. Lets an
   * `unsubscribe` arriving mid-await cancel the pending registration.
   */
  pendingSubIds: Set<string>
}

export type RawConnections = Map<object, Connection>
export type SubSockets = Map<string, WSContext>
export type ResolveContext = (req: Request) => Promise<Record<string, unknown>>
export type Upgrade = UpgradeWebSocket
