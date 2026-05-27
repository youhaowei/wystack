/**
 * WebSocket adapter — bridges a browser `WebSocket` to the neutral
 * {@link createEngine} engine. Owns parsing the wire (via
 * `parseServerMessage` from `@wystack/transport`), encoding outbound frames,
 * and surfacing close codes to the engine's reconnect policy.
 *
 * Public surface (`createWsManager`, `WsManager`, `WsManagerConfig`) is
 * preserved for backward compatibility with existing consumers (`client.ts`,
 * `hooks.ts`, app code). It is a thin layer over the engine and will be
 * relocated when the dedicated browser-transport task (T3b) lands.
 *
 * Wire protocol (mirrors `@wystack/server`):
 *   Client → Server: { type: 'auth', token }
 *   Client → Server: { type: 'subscribe', id, path, args }
 *   Client → Server: { type: 'unsubscribe', id }
 *   Server → Client: { type: 'authenticated' }
 *   Server → Client: { type: 'subscribed', id }
 *   Server → Client: { type: 'invalidate', id }
 *   Server → Client: { type: 'error', id?, error, issues? }
 *
 * Close codes:
 *   4001 — auth failed / protocol violation → latch authFailed, no reconnect
 *   4002 — transient (timeout, flake) → reconnect per exponential backoff
 */
import type { ServerMessage, ClientMessage, Pipe } from '@wystack/transport'
import { parseServerMessage } from '@wystack/transport'
import { createEngine, type Engine, type EnginePipe, type CloseInfo } from './engine'

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
  subscribe(id: string, path: string, args: unknown, onInvalidate: InvalidateHandler): void
  unsubscribe(id: string): void
  isConnected(): boolean
}

/**
 * Build an {@link EnginePipe} from a fresh `WebSocket` connection. Encodes
 * `ClientMessage` to JSON on send, parses `ServerMessage` from JSON on
 * receive (malformed frames are dropped — they cannot be acted on), and
 * surfaces the native close `code` to the engine via `onClose`.
 *
 * Returned eagerly — the engine treats the pipe as live the moment it has
 * the reference. Frames sent before the socket reaches `OPEN` are queued
 * by buffering them in a small array; once `onopen` fires, the buffer is
 * flushed. This matches the prior `ws.ts` behavior, where the auth frame
 * was sent inside `onopen`.
 */
function createWebSocketPipe(url: string): EnginePipe {
  const socket = new WebSocket(url)
  const messageHandlers = new Set<(msg: ServerMessage) => void>()
  const closeHandlers = new Set<(info: CloseInfo) => void>()
  const outboundBuffer: ClientMessage[] = []
  let opened = false
  let closed = false

  socket.onopen = () => {
    opened = true
    for (const msg of outboundBuffer) socket.send(JSON.stringify(msg))
    outboundBuffer.length = 0
  }

  socket.onmessage = (event) => {
    const data = typeof event.data === 'string' ? event.data : ''
    const parsed = parseServerMessage(data)
    if (parsed === null) return
    for (const handler of Array.from(messageHandlers)) handler(parsed)
  }

  socket.onclose = (event) => {
    if (closed) return
    closed = true
    // Native CloseEvent.code is 1000 for a clean close, 1006 for an abnormal
    // close, or one of our app-level codes (4001/4002). All are surfaced
    // verbatim so the engine policy lives in one place.
    const info: CloseInfo = { code: event.code }
    for (const handler of Array.from(closeHandlers)) handler(info)
  }

  socket.onerror = () => {
    // onclose follows; no separate signal needed.
  }

  const pipe: Pipe<ServerMessage, ClientMessage> = {
    id: url,
    send(message: ClientMessage): void {
      if (closed) return
      if (opened) {
        socket.send(JSON.stringify(message))
      } else {
        outboundBuffer.push(message)
      }
    },
    onMessage(handler: (msg: ServerMessage) => void): () => void {
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    },
    close(): void {
      if (closed) return
      // Mark closed locally first so a subsequent close() callback from the
      // socket itself doesn't re-fire onClose handlers.
      closed = true
      // Drop the onclose listener so the engine doesn't receive a phantom
      // close event for its own request.
      socket.onclose = null
      socket.close()
    },
  }

  return {
    ...pipe,
    onClose(handler: (info: CloseInfo) => void): () => void {
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
  }
}

/**
 * Thin shim over {@link createEngine} for browser WebSocket transport.
 * Preserved as the public client surface; the engine is the new home for
 * lifecycle / auth / subscription logic.
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
      // The legacy `WsManager.subscribe` typed `args` as `unknown` to keep
      // hook callers from needing to assert. The engine narrows to a record
      // per `SubscribeMessage`; coerce here at the boundary.
      engine.subscribe(id, path, args as Record<string, unknown>, onInvalidate)
    },
    unsubscribe: (id) => engine.unsubscribe(id),
    isConnected: () => engine.isConnected(),
  }
}
