/**
 * Bun server entrypoint — Hono + Bun WebSocket adapter.
 *
 * Returns a wrapper with .port and .stop() matching the old Bun.serve() API
 * so existing tests work unchanged.
 */
import { upgradeWebSocket, websocket } from 'hono/bun'
import { createRoutes, type RouteOptions } from './routes'
import type { WyStackServer } from './types'

interface BunServeOptions extends RouteOptions {
  port?: number
  hostname?: string
}

export type { WyStackServer }

export function serve(opts: BunServeOptions): WyStackServer {
  const { port = 3000, hostname = '0.0.0.0' } = opts

  const routes = createRoutes(opts, upgradeWebSocket)

  const server = Bun.serve({
    fetch: routes.fetch,
    websocket,
    port,
    hostname,
  })

  return {
    get port() {
      return server.port ?? port
    },
    stop(immediate = false) {
      server.stop(immediate)
    },
  }
}
