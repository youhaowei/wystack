/**
 * Bun server entrypoint — Hono + Bun WebSocket adapter.
 *
 * Returns a wrapper with .port and .stop() matching the old Bun.serve() API
 * so existing tests work unchanged.
 */
import { upgradeWebSocket, websocket } from 'hono/bun'
import { createRoutes, type RouteOptions } from './routes'

interface BunServeOptions extends RouteOptions {
  port?: number
  hostname?: string
}

export interface WyStackServer {
  port: number
  stop(immediate?: boolean): void
}

export function serve(opts: BunServeOptions): WyStackServer {
  const { port = 3000, hostname = '0.0.0.0' } = opts

  const routes = createRoutes(opts, upgradeWebSocket)

  const server = Bun.serve({
    fetch: routes.fetch,
    websocket,
    port: port ?? 3000,
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
