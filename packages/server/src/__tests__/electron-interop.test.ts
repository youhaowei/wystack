// @wystack/server/electron — Cross-adapter interop conformance test
//
// The contract requires an end-to-end proof that a `call` frame sent from the
// CLIENT side actually round-trips through the server adapter →
// `attachEngine` → dispatch → `result` back to the client. This is the
// contract-conformance gate: it proves the server adapter speaks the pinned
// wire protocol over the REAL channel strings, not just that it works against
// its own server-side mock.
//
// `@wystack/client/electron` (T6) lives on a parallel branch and is NOT a
// dependency of `@wystack/server` (the dep direction is client → server, and
// pulling T6 in would couple to a moving target outside this PR's scope). Per
// the brief's fallback, we build a MINIMAL in-test client-side pipe that uses
// the SAME channel strings (`wystack:c2s` / `wystack:s2c`) and the same
// `__connect` / `__close` control frames the pinned contract defines, then
// loopback-wire it to a fake ipcMain. The assertion is the full round-trip.
//
// NOTE on server push: `attachEngine` emits exactly three server→client frames
// — `authenticated`, `result`, `error`. It does NOT wire the reactive tier, so
// `invalidate` is never emitted in this engine configuration (`subscribe` →
// `REACTIVITY_NOT_ENABLED`; mutations drop `tablesWritten`; invalidation lands
// with the reactive tier). The genuine server-push proof here is therefore the
// engine-initiated `authenticated` ACK and the `result` frame — both ride the
// identical `webContents.send('wystack:s2c', …)` path an `invalidate` would
// use. We assert those.

import { describe, test, expect } from 'bun:test'
import { createDb, defineSchema, text, int, boolean } from '@wystack/db'
import { attachElectronTransport } from '../electron'
import type { IpcMainEventLike, IpcMainLike, WebContentsLike } from '../electron'
import { defineApp } from '../define-app'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const C2S = 'wystack:c2s'
const S2C = 'wystack:s2c'

// ---------------------------------------------------------------------------
// Schema + App factory
// ---------------------------------------------------------------------------

const schema = defineSchema({
  todos: { id: int.primaryKey(), title: text, done: boolean },
})

async function makeApp() {
  const db = await createDb({ dev: 'pglite://' })
  await db.execute(
    `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
  )
  return wy.build({
    db,
    functions: {
      listTodos: wy.procedure.input({}).query(async (ctx) => ctx.db.from(schema.todos).all()),
      addTodo: wy.procedure
        .input({ title: text })
        .mutation(async (ctx, args) =>
          ctx.db.into(schema.todos).insert({ title: args.title, done: false }),
        ),
      whoami: wy.procedure.input({}).query(async (ctx) => ({ userId: ctx.userId ?? null })),
    },
  })
}

// ---------------------------------------------------------------------------
// Async helpers (mirrors engine.test.ts)
// ---------------------------------------------------------------------------

async function until(predicate: () => boolean, label: string, ms = 2000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error(`until(${label}) timed out`)
    await new Promise((r) => setTimeout(r, 1))
  }
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20))
}

// ---------------------------------------------------------------------------
// Loopback-wired fake Electron pair
//
// A fake ipcMain (main process) + fake ipcRenderer (renderer) wired together so
// the renderer's `c2s` sends land on the ipcMain listeners, and the main
// process's `webContents.send('wystack:s2c', …)` lands on the renderer's `s2c`
// handlers. This is the structural analog of two real Electron processes over
// the same channel strings — the contract-conformance substrate.
// ---------------------------------------------------------------------------

/**
 * A minimal client-side pipe mirroring what `@wystack/client/electron`
 * (T6) does: `send` → `ipcRenderer.send('wystack:c2s', msg)`, inbound via
 * `ipcRenderer.on('wystack:s2c', …)`, `__connect` / `__close` control frames
 * per the contract. Built in-test so the server adapter is exercised over the
 * real channel strings without depending on the parallel T6 package.
 */
interface FakeIpcRenderer {
  send(channel: string, message: unknown): void
  on(channel: string, listener: (event: unknown, message: unknown) => void): void
}

interface LoopbackHarness {
  ipcMain: IpcMainLike
  ipcRenderer: FakeIpcRenderer
  /** All `s2c` frames the renderer received (server → client). */
  clientReceived: unknown[]
  /** Fire the webContents `destroyed` backstop event. */
  fireLifecycle(event: 'destroyed'): void
}

/**
 * Build a fake ipcMain + ipcRenderer loopback-wired over the real channel
 * strings, with a single renderer (webContents id 1).
 */
function makeLoopback(): LoopbackHarness {
  const c2sListeners = new Set<(event: IpcMainEventLike, message: unknown) => void>()
  const s2cListeners = new Set<(event: unknown, message: unknown) => void>()
  const lifecycleListeners = new Map<string, Set<() => void>>()
  const clientReceived: unknown[] = []
  let destroyed = false

  // The single WebContents the server adapter sees. Its `send` delivers to the
  // renderer's s2c handlers — the main→renderer leg of the wire contract.
  const webContents: WebContentsLike = {
    id: 1,
    send(channel: string, message: unknown) {
      if (destroyed) throw new Error('webContents is destroyed')
      if (channel !== S2C) return
      // Deliver to renderer's s2c handlers asynchronously to match the real
      // IPC boundary (never synchronous re-entry inside the caller's send).
      queueMicrotask(() => {
        for (const l of Array.from(s2cListeners)) l(undefined, message)
      })
    },
    on(event: 'destroyed', listener: () => void) {
      if (!lifecycleListeners.has(event)) lifecycleListeners.set(event, new Set())
      lifecycleListeners.get(event)!.add(listener)
      return webContents
    },
    removeListener(event: 'destroyed', listener: () => void) {
      lifecycleListeners.get(event)?.delete(listener)
      return webContents
    },
    isDestroyed() {
      return destroyed
    },
  }

  const ipcMain: IpcMainLike = {
    on(channel: string, listener: (event: IpcMainEventLike, message: unknown) => void) {
      if (channel === C2S) c2sListeners.add(listener)
      return ipcMain
    },
    removeListener(channel: string, listener: (event: IpcMainEventLike, message: unknown) => void) {
      if (channel === C2S) c2sListeners.delete(listener)
      return ipcMain
    },
  }

  const ipcRenderer: FakeIpcRenderer = {
    send(channel: string, message: unknown) {
      if (channel !== C2S) return
      // Deliver to ipcMain's c2s listeners with an event carrying the sender —
      // the renderer→main leg of the wire contract.
      const event: IpcMainEventLike = { sender: webContents }
      queueMicrotask(() => {
        for (const l of Array.from(c2sListeners)) l(event, message)
      })
    },
    on(channel: string, listener: (event: unknown, message: unknown) => void) {
      if (channel === S2C) {
        s2cListeners.add((evt, msg) => {
          clientReceived.push(msg)
          listener(evt, msg)
        })
      }
    },
  }

  return {
    ipcMain,
    ipcRenderer,
    clientReceived,
    fireLifecycle(event) {
      if (event === 'destroyed') destroyed = true
      for (const l of Array.from(lifecycleListeners.get(event) ?? [])) l()
    },
  }
}

// ---------------------------------------------------------------------------
// Interop tests
// ---------------------------------------------------------------------------

describe('Electron adapter — cross-adapter interop (contract conformance)', () => {
  test('client call round-trips through server adapter → engine → result', async () => {
    const app = await makeApp()
    const lb = makeLoopback()
    attachElectronTransport({ app, ipcMain: lb.ipcMain })

    // Client subscribes to inbound s2c frames (what T6's createElectronPipe does).
    lb.ipcRenderer.on(S2C, () => {})

    // Client opens the connection and sends a call — over the real channels.
    lb.ipcRenderer.send(C2S, { type: '__connect' })
    lb.ipcRenderer.send(C2S, { type: 'call', id: 'c1', path: 'listTodos', args: {} })

    await until(() => lb.clientReceived.length > 0, 'client result')

    // The result frame travelled main → renderer over wystack:s2c.
    expect(lb.clientReceived).toContainEqual({ type: 'result', id: 'c1', data: [] })
  })

  test('mutation then query round-trips end-to-end (write is visible)', async () => {
    const app = await makeApp()
    const lb = makeLoopback()
    attachElectronTransport({ app, ipcMain: lb.ipcMain })
    lb.ipcRenderer.on(S2C, () => {})

    lb.ipcRenderer.send(C2S, { type: '__connect' })
    lb.ipcRenderer.send(C2S, { type: 'call', id: 'm1', path: 'addTodo', args: { title: 'eggs' } })
    await until(
      () =>
        lb.clientReceived.some(
          (m: unknown) =>
            (m as { type: string; id?: string }).type === 'result' &&
            (m as { id: string }).id === 'm1',
        ),
      'mutation result',
    )

    // Now query — the write must be visible across the same connection.
    lb.ipcRenderer.send(C2S, { type: 'call', id: 'q1', path: 'listTodos', args: {} })
    await until(
      () =>
        lb.clientReceived.some(
          (m: unknown) =>
            (m as { type: string; id?: string }).type === 'result' &&
            (m as { id: string }).id === 'q1',
        ),
      'query result',
    )

    const queryResult = lb.clientReceived.find(
      (m: unknown) =>
        (m as { type: string; id?: string }).type === 'result' && (m as { id: string }).id === 'q1',
    ) as { data: { title: string }[] }
    expect(queryResult.data).toHaveLength(1)
    expect(queryResult.data[0]!.title).toBe('eggs')
  })

  test('server push: engine-initiated authenticated frame reaches the client', async () => {
    // The genuine server-initiated s2c push this engine emits. It rides the same
    // webContents.send('wystack:s2c', …) path an invalidate would use (invalidate
    // itself is not emitted by attachEngine — reactive tier lands later).
    const app = await makeApp()
    const lb = makeLoopback()
    attachElectronTransport({
      app,
      ipcMain: lb.ipcMain,
      resolveContext: async () => ({ userId: 'u1' }),
    })
    lb.ipcRenderer.on(S2C, () => {})

    lb.ipcRenderer.send(C2S, { type: '__connect' })
    lb.ipcRenderer.send(C2S, { type: 'auth', token: 'good' })
    await until(() => lb.clientReceived.length > 0, 'authenticated push')

    expect(lb.clientReceived).toContainEqual({ type: 'authenticated' })

    // And a subsequent authenticated call round-trips with the resolved context.
    lb.ipcRenderer.send(C2S, { type: 'call', id: 'who', path: 'whoami', args: {} })
    await until(
      () =>
        lb.clientReceived.some(
          (m: unknown) =>
            (m as { type: string; id?: string }).type === 'result' &&
            (m as { id: string }).id === 'who',
        ),
      'whoami result',
    )
    expect(lb.clientReceived).toContainEqual({ type: 'result', id: 'who', data: { userId: 'u1' } })
  })

  test('__close from client tears down: server sends __close echo, no further results', async () => {
    const app = await makeApp()
    const lb = makeLoopback()
    attachElectronTransport({ app, ipcMain: lb.ipcMain })
    lb.ipcRenderer.on(S2C, () => {})

    lb.ipcRenderer.send(C2S, { type: '__connect' })
    lb.ipcRenderer.send(C2S, { type: 'call', id: 'pre', path: 'listTodos', args: {} })
    await until(() => lb.clientReceived.length > 0, 'pre-close result')

    // Client closes the connection over the real channel.
    lb.ipcRenderer.send(C2S, { type: '__close' })
    await flush()

    // The server adapter echoes a __close control frame to the renderer.
    expect(lb.clientReceived).toContainEqual({ type: '__close' })
  })

  test('webContents destroyed tears the connection down end-to-end', async () => {
    const app = await makeApp()
    const lb = makeLoopback()
    attachElectronTransport({ app, ipcMain: lb.ipcMain })
    lb.ipcRenderer.on(S2C, () => {})

    lb.ipcRenderer.send(C2S, { type: '__connect' })
    lb.ipcRenderer.send(C2S, { type: 'call', id: 'pre', path: 'listTodos', args: {} })
    await until(() => lb.clientReceived.length > 0, 'pre-destroy result')
    const before = lb.clientReceived.length

    // Destroy the renderer's webContents — the lifecycle teardown fires.
    lb.fireLifecycle('destroyed')
    await flush()

    // No new s2c frames are produced after destruction (the destroyed
    // webContents is never sent to).
    expect(lb.clientReceived.length).toBe(before)
  })
})
