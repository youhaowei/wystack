/**
 * Electron IPC transport adapter for `@wystack/client`.
 *
 * This is the client-side IPC transport — the adapter-layer peer of the server-
 * side `@wystack/server/electron` adapter (T5). It bridges Electron's
 * `ipcRenderer` event channels to the neutral {@link createEngine} engine via
 * the `EnginePipe` contract.
 *
 * Wire contract (pinned):
 *   - Client → main: `ipcRenderer.send('wystack:c2s', msg)` — plain object, no
 *     JSON.stringify (Electron IPC structured-clones).
 *   - Main → client: `ipcRenderer.on('wystack:s2c', (event, msg) => …)` — msg
 *     arrives as a plain object; `parseServerMessage(JSON.stringify(msg))` is
 *     used so the validated parser pipeline can run on it.
 *   - `__connect` control frame is sent on construction (synthesized lifecycle).
 *   - `__close` control frame on `s2c` fires `onClose({ code: 1000 })` —
 *     code 1000 (clean) keeps the engine from latching authFailed.
 *   - Control frames (`__connect`, `__close`) are filtered at the adapter
 *     boundary and NEVER forwarded to engine handlers.
 *
 * `electron` is NOT a dependency or peerDependency. Only the subset of
 * ipcRenderer actually used is typed via the structural {@link IpcRendererLike}
 * interface, keeping `@wystack/client` Electron-free and fully testable against
 * a fake renderer.
 *
 * See: packages/client/src/transport/websocket.ts (the WS structural analog)
 * See: .wystack/docs/ipc-transport-contract.md (the pinned wire contract)
 */
import type { ServerMessage, ClientMessage } from '@wystack/transport'
import { parseServerMessage } from '@wystack/transport'
import type { EnginePipe, CloseInfo } from '../engine'
import { createEngine, type Engine } from '../engine'

// ─── IPC channel names (contract-pinned) ─────────────────────────────────────

const C2S_CHANNEL = 'wystack:c2s'
const S2C_CHANNEL = 'wystack:s2c'

// ─── Structural type — no `electron` import ───────────────────────────────────

/**
 * The subset of Electron's `ipcRenderer` used by the adapter. Consumers pass
 * the real `ipcRenderer` from Electron's preload; tests pass a fake object
 * implementing this interface.
 *
 * `removeListener` (not `off`) is the canonical Electron method name.
 */
export interface IpcRendererLike {
  send(channel: string, ...args: unknown[]): void
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): this
  removeListener(channel: string, listener: (...args: unknown[]) => void): this
}

// ─── Control frame types (adapter-internal, never forwarded to engine) ────────

type ConnectFrame = { type: '__connect' }
type CloseFrame = { type: '__close' }

// ─── createElectronPipe ───────────────────────────────────────────────────────

/**
 * Build an {@link EnginePipe} from an Electron `ipcRenderer`.
 *
 * The pipe is returned eagerly. On construction it immediately sends a
 * `{ type: "__connect" }` control frame on `wystack:c2s` so the server adapter
 * knows a renderer has connected.
 *
 * Lifecycle:
 *   - `send(msg)` → `ipcRenderer.send('wystack:c2s', msg)`
 *   - Inbound `wystack:s2c` frames are JSON-parsed (via stringify round-trip to
 *     run `parseServerMessage`) then delivered to registered `onMessage` handlers.
 *   - `__close` on `wystack:s2c` → fires all `onClose` handlers with
 *     `{ code: 1000 }` (clean close).
 *   - `close()` sends `{ type: "__close" }` on `wystack:c2s`, removes the
 *     listener, and marks the pipe closed. Idempotent.
 */
export function createElectronPipe({
  ipcRenderer,
}: {
  ipcRenderer: IpcRendererLike
}): EnginePipe {
  const messageHandlers = new Set<(msg: ServerMessage) => void>()
  const closeHandlers = new Set<(info: CloseInfo) => void>()
  let closed = false

  // s2c listener — kept as a named reference so removeListener works
  const s2cListener = (_event: unknown, raw: unknown) => {
    if (closed) return

    // Filter adapter-internal control frames first
    if (
      raw !== null &&
      typeof raw === 'object' &&
      !Array.isArray(raw) &&
      (raw as Record<string, unknown>).type === '__close'
    ) {
      // Server sent a clean-close signal — fire onClose, tear down
      if (!closed) {
        closed = true
        ipcRenderer.removeListener(S2C_CHANNEL, s2cListener)
        const info: CloseInfo = { code: 1000 }
        for (const handler of Array.from(closeHandlers)) handler(info)
      }
      return
    }

    // Inbound payload: Electron structured-clones objects, so `raw` is already
    // a plain object. parseServerMessage expects a JSON string → stringify first.
    const parsed = parseServerMessage(JSON.stringify(raw))
    if (parsed === null) return
    for (const handler of Array.from(messageHandlers)) handler(parsed)
  }

  // Register the s2c listener immediately
  ipcRenderer.on(S2C_CHANNEL, s2cListener)

  // Synthesized connect lifecycle — send the __connect control frame so the
  // server adapter knows this renderer has opened a connection.
  const connectFrame: ConnectFrame = { type: '__connect' }
  ipcRenderer.send(C2S_CHANNEL, connectFrame)

  return {
    // id: use the channel name as a stable identifier (one renderer = one pipe)
    id: 'ipc-renderer',

    send(message: ClientMessage): void {
      if (closed) return
      // IPC structured-clones — send the plain object directly, no stringify
      ipcRenderer.send(C2S_CHANNEL, message)
    },

    onMessage(handler: (msg: ServerMessage) => void): () => void {
      messageHandlers.add(handler)
      return () => {
        messageHandlers.delete(handler)
      }
    },

    close(): void {
      if (closed) return
      closed = true
      ipcRenderer.removeListener(S2C_CHANNEL, s2cListener)
      // Notify the server that this renderer is closing
      const closeFrame: CloseFrame = { type: '__close' }
      ipcRenderer.send(C2S_CHANNEL, closeFrame)
    },

    onClose(handler: (info: CloseInfo) => void): () => void {
      closeHandlers.add(handler)
      return () => {
        closeHandlers.delete(handler)
      }
    },
  }
}

// ─── IpcManager (convenience shim — mirrors createWsManager / WsManager) ─────

/**
 * Configuration for {@link createIpcManager}.
 *
 * For the trusted IPC transport, `requiresAuth` defaults to `false` — the IPC
 * channel is in-process and the server adapter typically omits `resolveContext`.
 * Pass `requiresAuth: true` (or `getToken`) to opt into the auth handshake.
 */
export interface IpcManagerConfig {
  ipcRenderer: IpcRendererLike
  /**
   * Provide a token for the auth handshake. When set, the client sends an auth
   * frame on connect and waits for the server's `{type:"authenticated"}` ack.
   * Defaults off for the trusted IPC transport — pass `requiresAuth: true` to
   * force the handshake without a token.
   */
  getToken?: () => Promise<string | null> | string | null
  /**
   * Force auth on or off. Defaults to `false` for IPC (trusted, in-process).
   */
  requiresAuth?: boolean
  /** Max ms to wait for auth ack. Default: 10_000. */
  authAckTimeoutMs?: number
  /** Diagnostic hook: fires when the server acks a subscription. */
  onSubscribed?: (id: string) => void
}

/**
 * Thin shim over {@link createEngine} for the Electron IPC transport.
 *
 * Mirrors {@link createWsManager} in `ws.ts` — same connect/disconnect/
 * subscribe/unsubscribe/isConnected surface, backed by `ipcRenderer` instead
 * of a WebSocket.
 */
export interface IpcManager {
  connect(): void
  disconnect(): void
  subscribe(
    id: string,
    path: string,
    args: Record<string, unknown>,
    onInvalidate: () => void,
  ): void
  unsubscribe(id: string): void
  isConnected(): boolean
}

export function createIpcManager(config: IpcManagerConfig): IpcManager {
  const engine: Engine = createEngine({
    createPipe: () => createElectronPipe({ ipcRenderer: config.ipcRenderer }),
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
