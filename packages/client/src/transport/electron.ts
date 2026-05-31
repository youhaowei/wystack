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
 *     used so the validated parser pipeline can run on it. The stringify is
 *     guarded: a value the engine cannot serialize (BigInt, cyclic graph) is
 *     dropped as a malformed frame rather than thrown.
 *   - `__connect` control frame is the first frame on `c2s`, sent one microtask
 *     after construction. Deferring past the synchronous return lets the engine
 *     attach its `onMessage`/`onClose` handlers first, so an immediate server
 *     reply (especially an early `__close`) is observed instead of dropped. The
 *     `s2c` listener is still registered synchronously at construction, so no
 *     inbound frame is missed.
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
 * The pipe is returned eagerly. It registers its `s2c` listener synchronously
 * at construction, then sends the `{ type: "__connect" }` control frame one
 * microtask later — by which point the engine has attached its `onMessage` /
 * `onClose` handlers, so an immediate server reply is observed rather than
 * dropped. `__connect` remains the first frame on `c2s`.
 *
 * Lifecycle:
 *   - `send(msg)` → `ipcRenderer.send('wystack:c2s', msg)`
 *   - Inbound `wystack:s2c` data frames are JSON-parsed (via a guarded stringify
 *     round-trip to run `parseServerMessage`) then delivered to registered
 *     `onMessage` handlers. A frame that cannot be serialized is dropped.
 *   - `__connect` / `__close` on `wystack:s2c` are filtered at the boundary and
 *     never forwarded to `onMessage`. `__close` additionally fires all `onClose`
 *     handlers with `{ code: 1000 }` (clean close).
 *   - `close()` sends `{ type: "__close" }` on `wystack:c2s`, removes the
 *     listener, and marks the pipe closed. Idempotent.
 */
export function createElectronPipe({ ipcRenderer }: { ipcRenderer: IpcRendererLike }): EnginePipe {
  const messageHandlers = new Set<(msg: ServerMessage) => void>()
  const closeHandlers = new Set<(info: CloseInfo) => void>()
  let closed = false

  // Read the adapter-internal control-frame discriminator, if any. Control
  // frames (`__connect`, `__close`) are filtered at the boundary and never
  // forwarded into the engine's message handlers.
  function controlType(raw: unknown): '__connect' | '__close' | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
    const type = (raw as Record<string, unknown>).type
    if (type === '__connect' || type === '__close') return type
    return null
  }

  // s2c listener — kept as a named reference so removeListener works
  const s2cListener = (_event: unknown, raw: unknown) => {
    if (closed) return

    // Filter adapter-internal control frames first — never forward to onMessage.
    const control = controlType(raw)
    if (control === '__close') {
      // Server sent a clean-close signal — fire onClose, tear down.
      closed = true
      ipcRenderer.removeListener(S2C_CHANNEL, s2cListener)
      const info: CloseInfo = { code: 1000 }
      for (const handler of Array.from(closeHandlers)) handler(info)
      return
    }
    if (control === '__connect') {
      // `__connect` is a c2s frame; it is never legitimately inbound on s2c.
      // Drop it defensively for symmetry with the server adapter.
      return
    }

    // Inbound data frame: Electron structured-clones objects, so `raw` is
    // already a plain object. parseServerMessage expects a JSON string →
    // stringify first. The stringify is guarded: a value the engine cannot
    // serialize (BigInt, cyclic graph) is treated as a malformed frame and
    // dropped per the contract, never thrown.
    let json: string
    try {
      json = JSON.stringify(raw)
    } catch {
      return
    }
    const parsed = parseServerMessage(json)
    if (parsed === null) return
    for (const handler of Array.from(messageHandlers)) handler(parsed)
  }

  // Register the s2c listener synchronously so no inbound frame is missed.
  ipcRenderer.on(S2C_CHANNEL, s2cListener)

  // Synthesized connect lifecycle — defer the __connect control frame by one
  // microtask so the engine attaches its onMessage/onClose handlers (which it
  // does synchronously after createPipe() returns) before any server reply can
  // arrive. __connect stays the first frame on c2s. The `closed` guard
  // suppresses it if the engine called close() during this same tick (e.g.
  // disconnect mid-createPipe).
  let connectSent = false
  const flushConnect = () => {
    if (connectSent || closed) return
    connectSent = true
    const connectFrame: ConnectFrame = { type: '__connect' }
    ipcRenderer.send(C2S_CHANNEL, connectFrame)
  }
  queueMicrotask(flushConnect)

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
  subscribe(id: string, path: string, args: Record<string, unknown>, onInvalidate: () => void): void
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
