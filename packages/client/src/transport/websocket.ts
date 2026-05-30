/**
 * Browser WebSocket transport adapter for `@wystack/client`.
 *
 * This is the designated browser-transport slot — the adapter-layer peer of
 * `@wystack/server/bun` and `@wystack/server/node` on the server side, and the
 * future `@wystack/client/electron` adapter (T6).  It bridges a native browser
 * `WebSocket` to the neutral {@link createEngine} engine via the `EnginePipe`
 * contract.
 *
 * Responsibilities:
 *   - Parse inbound JSON frames into typed `ServerMessage` via
 *     `parseServerMessage`; drop malformed frames silently (cannot be acted on).
 *   - Encode outbound `ClientMessage` to JSON.
 *   - Surface native close codes (1000, 1006, 4001, 4002 …) to the engine so
 *     its 4001-latch / retry policy remains transport-neutral.
 *   - Buffer outbound frames in the CONNECTING state and flush on `onopen` —
 *     consumers do not need to wait for the socket to open before calling
 *     `send`.
 *
 * Moved here from `ws.ts` by the T3b relocation.  The `createWsManager` /
 * `WsManager` / `WsManagerConfig` public surface in `ws.ts` re-exports this
 * factory so existing consumers are unaffected.
 */
import type { ServerMessage, ClientMessage, Pipe } from '@wystack/transport'
import { parseServerMessage } from '@wystack/transport'
import type { EnginePipe, CloseInfo } from '../engine'

/**
 * Build an {@link EnginePipe} from a fresh `WebSocket` connection.
 *
 * The pipe is returned eagerly — the engine treats it as live the moment it
 * has the reference.  Frames sent before the socket reaches `OPEN` are queued
 * in a small buffer and flushed once `onopen` fires.
 *
 * @param url  WebSocket URL (e.g. `ws://localhost:3001/api/ws`).
 */
export function createWebSocketPipe(url: string): EnginePipe {
  const socket = new WebSocket(url)
  const messageHandlers = new Set<(msg: ServerMessage) => void>()
  const closeHandlers = new Set<(info: CloseInfo) => void>()
  const outboundBuffer: ClientMessage[] = []
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  let opened = false
  let closed = false

  socket.onopen = () => {
    opened = true
    resolveReady()
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
    if (!opened) rejectReady(new Error(`WebSocket closed before open (${event.code})`))
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
      if (!opened) rejectReady(new Error('WebSocket closed before open'))
      // Drop the onclose listener so the engine doesn't receive a phantom
      // close event for its own request.
      socket.onclose = null
      socket.close()
    },
  }

  return {
    ...pipe,
    ready,
    onClose(handler: (info: CloseInfo) => void): () => void {
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
  }
}
