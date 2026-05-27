/**
 * Browser WebSocket adapter for the neutral client engine.
 *
 * Protocol/lifecycle state lives in `engine.ts`; this module only adapts the
 * browser `WebSocket` API to a typed `@wystack/transport` Pipe.
 */

import {
  parseServerMessage,
  type ClientMessage,
  type Pipe,
  type ServerMessage,
} from '@wystack/transport'
import { createClientEngine, type ClientEngine } from './engine'

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
   * via cookies or proxy headers rather than a client-supplied token.
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

export function createWsManager(config: WsManagerConfig): WsManager {
  const onProtocolError = (error: unknown) => {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[wystack/ws] Failed to parse message:', error)
    }
  }

  const engine = createClientEngine({
    createPipe: () => createWebSocketPipe(config.url, onProtocolError),
    getToken: config.getToken,
    requiresAuth: config.requiresAuth,
    authAckTimeoutMs: config.authAckTimeoutMs,
    onSubscribed: config.onSubscribed,
    onProtocolError,
  })

  return {
    connect: engine.connect,
    disconnect: engine.disconnect,
    subscribe(id, path, args, onInvalidate) {
      engine.subscribe(id, path, normalizeArgs(args), onInvalidate)
    },
    unsubscribe: engine.unsubscribe,
    isConnected: engine.isConnected,
  }
}

function createWebSocketPipe(
  url: string,
  onProtocolError: (error: unknown) => void,
): Promise<{
  pipe: Pipe<ServerMessage, ClientMessage>
  closed: Promise<{ code?: number; reason?: string }>
}> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket

    try {
      socket = new WebSocket(url)
    } catch (error) {
      reject(error)
      return
    }

    const handlers = new Set<(message: ServerMessage) => void>()
    let settled = false
    let closeResolved = false
    let resolveClosed!: (event: { code?: number; reason?: string }) => void
    const closed = new Promise<{ code?: number; reason?: string }>((res) => {
      resolveClosed = res
    })

    function finishClose(event: { code?: number; reason?: string }) {
      if (closeResolved) return
      closeResolved = true
      resolveClosed(event)
    }

    const pipe: Pipe<ServerMessage, ClientMessage> = {
      id: `ws:${url}`,
      send(message) {
        if (socket.readyState !== WebSocket.OPEN) return
        socket.send(JSON.stringify(message))
      },
      onMessage(handler) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
      close() {
        if (socket.readyState === WebSocket.CLOSED) {
          return
        }
        socket.close()
      },
    }

    socket.onopen = () => {
      settled = true
      resolve({ pipe, closed })
    }

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const message = parseServerMessage(event.data)
      if (message === null) {
        onProtocolError(new Error(`Malformed server message: ${event.data}`))
        return
      }
      for (const handler of handlers) handler(message)
    }

    socket.onerror = () => {
      if (!settled) {
        settled = true
        reject(new Error('WebSocket connection failed'))
      }
    }

    socket.onclose = (event) => {
      if (!settled) {
        settled = true
        reject(new Error(`WebSocket closed before open: ${event.code}`))
      }
      finishClose({ code: event.code, reason: event.reason })
    }
  })
}

function normalizeArgs(args: unknown): Record<string, unknown> {
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>
  }
  return {}
}

export type { ClientEngine }
