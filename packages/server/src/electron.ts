// @wystack/server/electron — Electron IPC transport adapter (YW-67 / T5)
//
// Binds Electron's ipcMain + webContents into a Pipe per BrowserWindow and
// drives `attachEngine`. Per the pinned IPC transport contract:
//
//   - Event channels (NOT invoke/handle): wystack:c2s (renderer→main),
//     wystack:s2c (main→renderer). Server push requires one-way events.
//   - Per-webContents.id connection keying. Pipe.id = `ipc-${webContents.id}`.
//   - Synthesized lifecycle: __connect opens the connection, __close closes it.
//     Both control frames are filtered at the adapter boundary — never forwarded
//     into the engine.
//   - Electron-free: IpcMainLike / WebContentsLike structural interfaces capture
//     only the methods used so this package has no Electron dependency.

import type { Pipe } from '@wystack/transport'
import { attachEngine, type AttachEngineOptions, type EngineHandle } from './engine'
import type { WyStackApp } from './create'

// ---------------------------------------------------------------------------
// Structural interfaces — no Electron dep, testable with a fake ipcMain
// ---------------------------------------------------------------------------

/** Minimal interface for the IPC event object passed to ipcMain.on callbacks. */
export interface IpcMainEventLike {
  readonly sender: WebContentsLike
}

/** Minimal interface for Electron's WebContents, capturing only what the adapter uses. */
export interface WebContentsLike {
  /** Stable numeric id for this WebContents; used as the connection key. */
  readonly id: number
  /** Send a structured-clone message to the renderer on the given channel. */
  send(channel: string, message: unknown): void
  /** Listen for a lifecycle event. */
  on(event: 'destroyed' | 'did-finish-load', listener: () => void): this
  /** Remove a lifecycle listener. */
  removeListener(event: 'destroyed' | 'did-finish-load', listener: () => void): this
  /** Optional — guards `send` against use after destruction in real Electron. */
  isDestroyed?(): boolean
}

/** Minimal interface for Electron's ipcMain, capturing only what the adapter uses. */
export interface IpcMainLike {
  on(channel: string, listener: (event: IpcMainEventLike, message: unknown) => void): this
  removeListener(
    channel: string,
    listener: (event: IpcMainEventLike, message: unknown) => void,
  ): this
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

const C2S = 'wystack:c2s'
const S2C = 'wystack:s2c'

// ---------------------------------------------------------------------------
// Adapter options
// ---------------------------------------------------------------------------

export interface AttachElectronTransportOptions {
  app: WyStackApp
  ipcMain: IpcMainLike
  /**
   * Optional resolver called for each inbound message event. Defaults to
   * returning `event.sender`. Useful in tests to supply a richer fake or in
   * production to remap to a specific WebContents if needed.
   */
  getWebContents?: (event: IpcMainEventLike) => WebContentsLike
  /**
   * Forwarded to `attachEngine`. Omit for the trusted IPC transport (no-auth,
   * connection starts authenticated). Provide to require a WyStack auth
   * handshake over IPC (uncommon).
   */
  resolveContext?: AttachEngineOptions['resolveContext']
  /** Forwarded to `attachEngine`. Default 10_000 ms. */
  authTimeoutMs?: number
  /**
   * Called when any individual connection closes, forwarded to `attachEngine`'s
   * `onClose`. Optional; trusted transports typically ignore it.
   */
  onClose?: AttachEngineOptions['onClose']
}

// ---------------------------------------------------------------------------
// Per-connection state
// ---------------------------------------------------------------------------

interface Connection {
  pipe: PipeImpl
  handle: EngineHandle
  webContents: WebContentsLike
  destroyedListener: () => void
  reloadListener: () => void
}

// ---------------------------------------------------------------------------
// Pipe implementation
// ---------------------------------------------------------------------------

/** Internal pipe wired to a single Electron WebContents. */
class PipeImpl implements Pipe<unknown, unknown> {
  readonly id: string
  private readonly _webContents: WebContentsLike
  private readonly _handlers = new Set<(message: unknown) => void>()
  private _closed = false

  constructor(webContentsId: number, webContents: WebContentsLike) {
    this.id = `ipc-${webContentsId}`
    this._webContents = webContents
  }

  send(message: unknown): void {
    if (this._closed) return
    if (this._webContents.isDestroyed?.()) return
    try {
      this._webContents.send(S2C, message)
    } catch {
      // webContents may be destroyed between the isDestroyed check and the send
    }
  }

  onMessage(handler: (message: unknown) => void): () => void {
    if (this._closed) return () => {}
    this._handlers.add(handler)
    return () => {
      this._handlers.delete(handler)
    }
  }

  /**
   * Close the pipe. By default sends a `{ type: '__close' }` control frame to
   * the renderer so the client adapter can synthesize its onClose lifecycle.
   *
   * `suppressEcho` skips that outbound frame — used on the reload
   * (`did-finish-load`) teardown path, where the webContents is still alive but
   * now hosts the freshly-loaded renderer: echoing `__close` there would close
   * the NEW page before it connects.
   */
  close(suppressEcho = false): void {
    if (this._closed) return
    this._closed = true
    if (!suppressEcho) {
      try {
        if (!this._webContents.isDestroyed?.()) {
          this._webContents.send(S2C, { type: '__close' })
        }
      } catch {
        /* webContents may already be gone */
      }
    }
    this._handlers.clear()
  }

  /** Deliver an inbound message to all registered handlers (engine's onMessage). */
  _dispatch(message: unknown): void {
    if (this._closed) return
    for (const handler of Array.from(this._handlers)) {
      if (!this._handlers.has(handler)) continue
      try {
        handler(message)
      } catch (err) {
        queueMicrotask(() => {
          throw err
        })
      }
    }
  }

  get closed(): boolean {
    return this._closed
  }
}

// ---------------------------------------------------------------------------
// Top-level adapter
// ---------------------------------------------------------------------------

/**
 * Attach the WyStack engine to Electron's IPC transport.
 *
 * Binds `ipcMain.on('wystack:c2s', …)` and creates one `Pipe` per
 * `webContents.id`, calling `attachEngine(pipe, …)` on the first frame
 * from each renderer. The `__connect`/`__close` control frames are filtered
 * at this boundary — never forwarded into the engine.
 *
 * Returns a `detach()` that removes the shared ipcMain listener and tears
 * down all active connections.
 */
export function attachElectronTransport(opts: AttachElectronTransportOptions): { detach(): void } {
  const { app, ipcMain, resolveContext, authTimeoutMs, onClose } = opts
  const getWebContents = opts.getWebContents ?? ((e: IpcMainEventLike) => e.sender)

  const connections = new Map<number, Connection>()

  /**
   * Tear down a single connection by webContents id. Removes lifecycle listeners,
   * clears the map entry, marks the pipe closed, and detaches the engine.
   * Idempotent: no-op when no connection exists for the id.
   *
   * Runs on EVERY close path — client `__close`, `destroyed` / reload lifecycle
   * events, AND engine-initiated close (auth timeout / failed auth) routed
   * through the per-connection `onClose` below. Clearing the map on engine close
   * is load-bearing: otherwise a stale entry blocks the next `__connect` from
   * the same webContents.id, permanently deadening that window.
   *
   * `suppressEcho` skips the outbound `__close` frame. Set on the reload
   * (`did-finish-load`) path: the webContents is alive but now hosts the new
   * renderer, so an echo would close the freshly-loaded page before it connects.
   */
  function teardown(wcId: number, suppressEcho = false): void {
    const conn = connections.get(wcId)
    if (!conn) return
    connections.delete(wcId)
    // Remove lifecycle listeners before calling detach/close so the listeners
    // themselves cannot re-enter teardown.
    conn.webContents.removeListener('destroyed', conn.destroyedListener)
    conn.webContents.removeListener('did-finish-load', conn.reloadListener)
    // Mark the pipe closed BEFORE calling detach so pipe.close() skips the
    // webContents.send (destroyed webContents would throw in real Electron).
    conn.pipe.close(suppressEcho)
    conn.handle.detach()
  }

  /** Build a new connection for a webContents that has not been seen before. */
  function connect(wc: WebContentsLike): Connection {
    const pipe = new PipeImpl(wc.id, wc)

    // Lifecycle teardown listeners — registered once, removed in teardown().
    // The reload path suppresses the __close echo (live webContents, new page).
    const destroyedListener = () => teardown(wc.id)
    const reloadListener = () => teardown(wc.id, true)
    wc.on('destroyed', destroyedListener)
    wc.on('did-finish-load', reloadListener)

    const handle = attachEngine(pipe, {
      app,
      resolveContext,
      authTimeoutMs,
      // Engine-initiated close (auth timeout / failed auth frame on an
      // auth-required transport) lands here. Forward the reason to the user's
      // onClose, THEN tear down so the map entry is cleared — without this, the
      // engine's own pipe.close() leaves the connections map orphaned and the
      // window cannot reconnect. teardown() is idempotent and the engine has
      // already flipped its closed guard, so the detach() inside is a safe no-op.
      onClose: (reason) => {
        onClose?.(reason)
        teardown(wc.id)
      },
    })

    const conn: Connection = { pipe, handle, webContents: wc, destroyedListener, reloadListener }
    connections.set(wc.id, conn)
    return conn
  }

  /** Shared inbound listener registered once on ipcMain. */
  function c2sListener(event: IpcMainEventLike, message: unknown): void {
    const wc = getWebContents(event)
    const wcId = wc.id

    // Filter control frames — never forward into the engine.
    if (isControlFrame(message)) {
      if (message.type === '__connect') {
        // First frame from this renderer — open the connection.
        if (!connections.has(wcId)) {
          connect(wc)
        }
        return
      }
      if (message.type === '__close') {
        teardown(wcId)
        return
      }
      // Unknown control frame — ignore.
      return
    }

    // Non-control frame: open a connection on first sight (belt-and-suspenders
    // for clients that skip the explicit __connect), then dispatch.
    let conn = connections.get(wcId)
    if (!conn) {
      conn = connect(wc)
    }
    conn.pipe._dispatch(message)
  }

  ipcMain.on(C2S, c2sListener)

  return {
    detach(): void {
      ipcMain.removeListener(C2S, c2sListener)
      // Copy ids before iteration: teardown mutates the map.
      for (const id of Array.from(connections.keys())) {
        teardown(id)
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ControlFrame {
  type: '__connect' | '__close'
}

function isControlFrame(msg: unknown): msg is ControlFrame {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    !Array.isArray(msg) &&
    typeof (msg as Record<string, unknown>).type === 'string' &&
    ((msg as Record<string, unknown>).type === '__connect' ||
      (msg as Record<string, unknown>).type === '__close')
  )
}
