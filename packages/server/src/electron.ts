// @wystack/server/electron — Electron IPC transport adapter
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

/**
 * Minimal interface for Electron's WebContents, capturing only what the adapter
 * uses. Only the `destroyed` event is listened to — a backstop for a page that
 * died without sending `__close`. Per the IPC transport contract (model A),
 * `did-finish-load` is deliberately NOT a lifecycle signal (it fires on initial
 * load too, so reacting to it tears down freshly-connected engines); reload is
 * detected via a repeat `__connect` instead.
 */
export interface WebContentsLike {
  /** Stable numeric id for this WebContents; used as the connection key. */
  readonly id: number
  /** Send a structured-clone message to the renderer on the given channel. */
  send(channel: string, message: unknown): void
  /** Listen for the `destroyed` lifecycle event (backstop teardown). */
  on(event: 'destroyed', listener: () => void): this
  /** Remove the `destroyed` listener. */
  removeListener(event: 'destroyed', listener: () => void): this
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
   * `suppressEcho` skips that outbound frame. It is set on the paths where the
   * old connection's renderer must NOT receive a close:
   *   - reload-replace: a repeat `__connect` from a known `wc.id` means the page
   *     re-ran its JS; the new page must not get a close for the dead connection.
   *   - `destroyed`: the page is gone — nothing to send to.
   *   - engine-initiated close: the engine handles the wire close itself.
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
 * `webContents.id`, calling `attachEngine(pipe, …)` on `__connect`. The
 * connection lifecycle is driven entirely by the client's `__connect`/`__close`
 * control frames (model A) — a repeat `__connect` from a known `wc.id` silently
 * replaces (reload); `destroyed` is the only `webContents` event listened to
 * (backstop). The control frames are filtered here — never forwarded into the
 * engine.
 *
 * Returns a `detach()` that removes the shared ipcMain listener and tears
 * down all active connections (echoing `__close` to each still-live renderer).
 */
export function attachElectronTransport(opts: AttachElectronTransportOptions): { detach(): void } {
  const { app, ipcMain, resolveContext, authTimeoutMs, onClose } = opts
  const getWebContents = opts.getWebContents ?? ((e: IpcMainEventLike) => e.sender)

  const connections = new Map<number, Connection>()

  /**
   * Tear down a single connection by webContents id. Removes the `destroyed`
   * listener, clears the map entry, marks the pipe closed, and detaches the
   * engine. Idempotent: no-op when no connection exists for the id.
   *
   * Reached from EVERY close path via a single function (contract robustness
   * invariant): explicit client `__close`, the `destroyed` backstop,
   * reload-replace, engine-initiated `onClose`, and top-level `detach`. Clearing
   * the map on every path is load-bearing — a stale entry blocks the next
   * `__connect` from the same webContents.id and permanently deadens that window.
   *
   * `suppressEcho` skips the outbound `__close` frame. It is `true` on the
   * reload-replace, `destroyed`, and engine-initiated paths (see `close()`).
   */
  function teardown(wcId: number, suppressEcho = false): void {
    const conn = connections.get(wcId)
    if (!conn) return
    connections.delete(wcId)
    // Remove the destroyed listener before close/detach so it cannot re-enter
    // teardown for this (already-removed) connection.
    conn.webContents.removeListener('destroyed', conn.destroyedListener)
    // Mark the pipe closed BEFORE detaching so pipe.close() skips the
    // webContents.send (a destroyed webContents would throw in real Electron).
    conn.pipe.close(suppressEcho)
    conn.handle.detach()
  }

  /**
   * Build a new connection for a webContents. Per the contract robustness
   * invariant, the map entry is inserted BEFORE the `destroyed` listener is
   * registered, so a `destroyed` firing mid-setup finds the entry to tear down.
   * `attachEngine` runs first (its handle is needed); if it throws synchronously
   * no listener has been registered yet, so nothing leaks.
   */
  function connect(wc: WebContentsLike): Connection {
    const pipe = new PipeImpl(wc.id, wc)

    const handle = attachEngine(pipe, {
      app,
      resolveContext,
      authTimeoutMs,
      // Engine-initiated close (auth timeout / failed auth on an auth-required
      // transport) lands here. Tear down FIRST (clearing the map so a later
      // `__connect` from the same wc.id builds fresh), THEN invoke the consumer
      // callback — so a throwing consumer onClose cannot leave a stale map
      // entry. suppressEcho: the engine already drives the wire close itself.
      // teardown is idempotent and the engine has flipped its closed guard
      // before calling this, so the detach() inside is a safe no-op.
      //
      // The consumer callback runs inside the engine's `closeWith`, which does
      // NOT guard it: `teardown() → onClose?.(reason) → void pipe.close()`. A
      // throw here would (a) skip the engine's own `pipe.close()`, corrupting
      // its close path, and (b) on the auth-timeout path escape an unguarded
      // `setTimeout` and crash the Electron main process. Neither is fixable
      // from the adapter without touching the engine (off-limits). Contain it:
      // teardown already ran (map is clean — the invariant holds), so we log and
      // drop the consumer's throw. A buggy close handler must not kill the app.
      onClose: (reason) => {
        teardown(wc.id, true)
        if (onClose === undefined) return
        try {
          onClose(reason)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('[wystack/server] electron onClose threw', err)
        }
      },
    })

    const destroyedListener = () => teardown(wc.id, true)
    const conn: Connection = { pipe, handle, webContents: wc, destroyedListener }
    // Map insert BEFORE listener registration (robustness invariant).
    connections.set(wc.id, conn)
    try {
      wc.on('destroyed', destroyedListener)
    } catch (err) {
      // Listener registration failed — don't leave a half-built entry.
      connections.delete(wc.id)
      void pipe.close(true)
      handle.detach()
      throw err
    }
    return conn
  }

  /** Shared inbound listener registered once on ipcMain. */
  function c2sListener(event: IpcMainEventLike, message: unknown): void {
    const wc = getWebContents(event)
    const wcId = wc.id

    // Filter control frames — never forward into the engine.
    if (isControlFrame(message)) {
      if (message.type === '__connect') {
        // Reload-replace rule (model A): a repeat `__connect` from a known
        // wc.id means the renderer re-ran its JS (reload). Silently replace —
        // tear the old connection down WITHOUT echoing `__close` to the new
        // page — then build fresh. A first-time `__connect` just builds.
        if (connections.has(wcId)) {
          teardown(wcId, true)
        }
        connect(wc)
        return
      }
      if (message.type === '__close') {
        // Explicit client-initiated close — echo `__close` so the client's
        // EnginePipe.onClose fires (the client is still live and expects it).
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
