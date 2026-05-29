/**
 * WebSocket adapter shim — public surface for the browser WS transport.
 *
 * The `createWebSocketPipe` browser transport adapter has been relocated to
 * `./transport/websocket` (T3b) and is exported from the package root
 * (`@wystack/client`). This module wraps it in the `createWsManager`
 * convenience surface so existing consumers (`client.ts`, `hooks.ts`, app
 * code) continue to work unchanged.
 *
 * Public surface (`createWsManager`, `WsManager`, `WsManagerConfig`) is
 * stable — import from `@wystack/client`.
 *
 * Close codes (handled by the engine, surfaced through the adapter):
 *   4001 — auth failed / protocol violation → latch authFailed, no reconnect
 *   4002 — transient (timeout, flake) → reconnect per exponential backoff
 */
import { createEngine, type Engine } from './engine'
import { createWebSocketPipe } from './transport/websocket'

type InvalidateHandler = () => void

export interface WsManagerConfig {
  url: string
  /**
   * Provide a token for Bearer auth. When set, the client sends an auth frame
   * on connect and waits for the server's `{type:"authenticated"}` ack before
   * replaying subscriptions. Return `null` for anonymous auth (e.g., cookie /
   * session-based) — the auth frame is still sent with no token, triggering
   * `resolveContext` on the server with the original upgrade request headers.
   *
   * Set `requiresAuth: false` to force a trusted/no-auth WS connection even
   * when `getToken` exists for HTTP. This is the intended mode for transports
   * with in-process trust, such as IPC-backed local runtimes.
   */
  getToken?: () => Promise<string | null> | string | null
  /**
   * Send an auth frame on connect even when `getToken` is not provided.
   * Use this for servers that have `resolveContext` configured but authenticate
   * via cookies or proxy headers rather than a client-supplied token — the auth
   * frame carries no token but still triggers `resolveContext` on the server.
   *
   * Defaults to `true` when `getToken` is set, `false` otherwise.
   */
  requiresAuth?: boolean
  /**
   * Max ms to wait for the server's `{type:"authenticated"}` ack after sending
   * the auth frame. Only applies when auth is required. Default: 10_000.
   */
  authAckTimeoutMs?: number
  /** Test/diagnostic hook for the server's subscription acknowledgement. */
  onSubscribed?: (id: string) => void
}

export interface WsManager {
  connect(): void
  disconnect(): void
  subscribe(
    id: string,
    path: string,
    args: Record<string, unknown>,
    onInvalidate: InvalidateHandler,
  ): void
  unsubscribe(id: string): void
  isConnected(): boolean
}

/**
 * Thin shim over {@link createEngine} for browser WebSocket transport.
 * Preserved as the public client surface; the engine owns lifecycle / auth /
 * subscription logic, while the adapter ({@link createWebSocketPipe}) owns
 * the wire encoding and close-code surfacing.
 */
export function createWsManager(config: WsManagerConfig): WsManager {
  const engine: Engine = createEngine({
    createPipe: () => createWebSocketPipe(config.url),
    getToken: config.getToken,
    requiresAuth: config.requiresAuth,
    authAckTimeoutMs: config.authAckTimeoutMs,
    onSubscribed: config.onSubscribed,
  })

  return {
    connect: () => engine.connect(),
    disconnect: () => engine.disconnect(),
    subscribe(id, path, args, onInvalidate) {
      engine.subscribe(id, path, args, onInvalidate)
    },
    unsubscribe: (id) => engine.unsubscribe(id),
    isConnected: () => engine.isConnected(),
  }
}
