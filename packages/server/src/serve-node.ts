/**
 * Node server entrypoint — Hono + @hono/node-server + @hono/node-ws.
 *
 * For Electron main process or any Node.js runtime.
 * Returns a wrapper with .port and .stop() matching the Bun API.
 */
import { Hono } from 'hono'
import { serve as nodeServe } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { createRoutes, type RouteOptions } from './routes'
import type { WyStackServer } from './types'

interface NodeServeOptions extends RouteOptions {
  port?: number
  hostname?: string
}

export function serve(opts: NodeServeOptions): WyStackServer {
  const { port = 3000, hostname = '0.0.0.0' } = opts

  const nodeApp = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: nodeApp })

  const routes = createRoutes(opts, upgradeWebSocket)
  nodeApp.route('/', routes)

  let resolvedPort = port
  const server = nodeServe({ fetch: nodeApp.fetch, port, hostname }, (info) => {
    resolvedPort = info.port
  })

  injectWebSocket(server)

  return {
    get port() {
      return resolvedPort
    },
    stop(_immediate = false) {
      server.close()
    },
  }
}
