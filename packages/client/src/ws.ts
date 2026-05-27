/**
 * WebSocket adapter (browser runtime).
 *
 * This module is intentionally thin: it adapts `WebSocket` to a `Pipe`-like
 * connection and delegates lifecycle/auth/subscriptions/correlation to the
 * neutral client engine (`./engine`).
 */

import type { Pipe } from '@wystack/transport'
import { createClientEngine, type PipeConnection } from './engine'

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

export function createWsManager(config: WsManagerConfig): WsManager {
  function generateId() {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
    if (c && typeof c.randomUUID === 'function') return c.randomUUID()
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  async function createConnection(): Promise<PipeConnection<string, string>> {
    const socket = new WebSocket(config.url)
    const id = `ws-${generateId()}`

    const messageHandlers = new Set<(message: string) => void>()
    const closeHandlers = new Set<(info: { code?: number; reason?: string }) => void>()
    let closed = false

    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      for (const handler of Array.from(messageHandlers)) handler(event.data)
    }

    socket.onclose = (event) => {
      if (closed) return
      closed = true
      const info = { code: event.code, reason: event.reason }
      for (const handler of Array.from(closeHandlers)) handler(info)
      messageHandlers.clear()
      closeHandlers.clear()
    }

    socket.onerror = () => {
      // onclose will follow in browsers
    }

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('WebSocket error'))
    })

    const pipe: Pipe<string, string> = {
      id,
      send(message: string) {
        if (closed) return
        if (socket.readyState !== WebSocket.OPEN) return
        socket.send(message)
      },
      onMessage(handler) {
        if (closed) return () => {}
        messageHandlers.add(handler)
        return () => {
          messageHandlers.delete(handler)
        }
      },
      close() {
        if (closed) return
        closed = true
        try {
          socket.close()
        } catch {
          // ignore
        }
      },
    }

    return {
      pipe,
      onClose(handler) {
        if (closed) return () => {}
        closeHandlers.add(handler)
        return () => {
          closeHandlers.delete(handler)
        }
      },
    }
  }

  const engine = createClientEngine({
    createConnection,
    getToken: config.getToken,
    requiresAuth: config.requiresAuth,
    authAckTimeoutMs: config.authAckTimeoutMs,
    onSubscribed: config.onSubscribed,
  })

  return {
    connect: () => engine.connect(),
    disconnect: () => engine.disconnect(),
    subscribe: (id, path, args, onInvalidate) => {
      engine
        .subscribe(id, path, (args ?? {}) as Record<string, unknown>, onInvalidate)
        .catch(() => {})
    },
    unsubscribe: (id) => {
      engine.unsubscribe(id).catch(() => {})
    },
    isConnected: () => engine.isConnected(),
  }
}
