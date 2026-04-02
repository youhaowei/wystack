/**
 * startRuntime — the main entry point for bootstrapping a WyStack server.
 *
 * Orchestrates:
 * 1. Port discovery (find available port or use specified)
 * 2. Server startup (picks adapter based on runtime)
 * 3. Port file writing (for tooling/client discovery)
 * 4. Signal handling (graceful shutdown on SIGINT/SIGTERM)
 * 5. Lifecycle hooks (onStart/onStop)
 *
 * Returns a RuntimeHandle with port, URL, and shutdown method.
 */

import type { WyStackApp, WyStackServer } from '@wystack/server'
import { findAvailablePort, writePortFile, removePortFile } from './port'
import { createLifecycle } from './lifecycle'
import { detectRuntime, type Runtime } from './env'

export interface RuntimeOptions {
  /** The WyStack app (from createWyStack) */
  app: WyStackApp
  /** Port to listen on. 0 = auto-find. Default: 3210 */
  port?: number
  /** Hostname to bind to. Default: '0.0.0.0' */
  hostname?: string
  /** Project root directory for port file. Omit to skip port file. */
  dir?: string
  /** URL prefix for API routes. Default: '/api' */
  prefix?: string
  /** Resolve request context (auth, tenant). */
  resolveContext?: (req: Request) => Promise<Record<string, unknown>>
  /** Hook called after server starts. */
  onStart?: () => void | Promise<void>
  /** Hook called before server stops. */
  onStop?: () => void | Promise<void>
  /** Install signal handlers for graceful shutdown. Default: true */
  signals?: boolean
}

export interface RuntimeHandle {
  /** The port the server is listening on. */
  port: number
  /** The full base URL (e.g., 'http://localhost:3210'). */
  url: string
  /** The detected runtime environment. */
  runtime: Runtime
  /** The process ID. */
  pid: number
  /** Gracefully shut down the server. Idempotent. */
  shutdown(): Promise<void>
}

export async function startRuntime(opts: RuntimeOptions): Promise<RuntimeHandle> {
  const {
    app,
    port: requestedPort = 3210,
    hostname = '0.0.0.0',
    dir,
    prefix,
    resolveContext,
    signals = true,
  } = opts

  const runtime = detectRuntime()
  const lifecycle = createLifecycle()

  // 1. Find available port
  const port = requestedPort === 0
    ? await findAvailablePort()
    : await findAvailablePort({ preferred: requestedPort })

  // 2. Start the server using the appropriate adapter
  const server = await startServer({
    app,
    port,
    hostname,
    prefix,
    resolveContext,
    runtime,
  })

  // The actual port might differ from requested (server may have picked another)
  const actualPort = server.port

  // 3. Write port file (if dir provided)
  if (dir) {
    await writePortFile(actualPort, { dir })
    lifecycle.onStop(async () => {
      await removePortFile({ dir })
    })
  }

  // 4. Register server stop on lifecycle
  lifecycle.onStop(() => {
    server.stop(false)
  })

  // 5. Register user hooks
  if (opts.onStart) lifecycle.onStart(opts.onStart)
  if (opts.onStop) lifecycle.onStop(opts.onStop)

  // 6. Signal handling
  let signalCleanup: (() => void) | undefined
  if (signals) {
    const onSignal = () => {
      handle.shutdown()
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    signalCleanup = () => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
  }

  // 7. Run start hooks
  await lifecycle.start()

  const handle: RuntimeHandle = {
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    runtime,
    pid: process.pid,

    async shutdown() {
      signalCleanup?.()
      await lifecycle.stop()
    },
  }

  return handle
}

// --- Server adapter selection ---

interface StartServerOptions {
  app: WyStackApp
  port: number
  hostname: string
  prefix?: string
  resolveContext?: (req: Request) => Promise<Record<string, unknown>>
  runtime: Runtime
}

async function startServer(opts: StartServerOptions): Promise<WyStackServer> {
  const { app, port, hostname, prefix, resolveContext, runtime } = opts
  const serveOpts = { app, prefix, resolveContext, port, hostname }

  // Bun native adapter — best performance, native WebSocket support
  if (runtime === 'bun') {
    const mod = await import('@wystack/server/bun')
    return mod.serve(serveOpts)
  }

  // Node.js and Electron both use the @hono/node-server adapter
  // (Electron's main process is a Node.js runtime)
  const mod = await import('@wystack/server/node')
  return mod.serve(serveOpts)
}
