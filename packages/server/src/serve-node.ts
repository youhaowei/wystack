/**
 * Node server entrypoint — Hono + @hono/node-server + @hono/node-ws.
 *
 * For Electron main process or any Node.js runtime.
 * Returns a wrapper with .port and .stop() matching the Bun API.
 */
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse, Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { Hono } from 'hono'
import { serve as nodeServe, getRequestListener } from '@hono/node-server'
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
    stop(immediate = false) {
      // oxlint-disable-next-line typescript/no-explicit-any -- @hono/node-server doesn't expose closeAllConnections in its types
      if (immediate) (server as any).closeAllConnections?.()
      server.close()
    },
  }
}

type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

export interface MountedRoutes {
  /**
   * Fetch handler for HTTP requests under the prefix (queries/mutations). The
   * host routes `${prefix}/*` HTTP requests here; everything else is the host's.
   */
  fetch: (request: Request) => Response | Promise<Response>
  /**
   * Node-native counterpart of `fetch`: a `(req, res)` listener for connect-style
   * middleware stacks (Vite dev) and raw `http.Server`s. The host gates by path
   * and forwards `${prefix}/*` requests here; it does NOT strip the prefix (the
   * routes match the full path). Bridges IncomingMessage↔Request via
   * `@hono/node-server`, so the consumer needs no Fetch adapter of its own.
   */
  requestListener: (req: IncomingMessage, res: ServerResponse) => void
  /**
   * WS upgrade handler, PATH-GATED to the route prefix. Attach to the host
   * server's `'upgrade'` event: it handles `${prefix}/ws` upgrades and RETURNS
   * (touching nothing) for any other path, leaving them to sibling listeners —
   * e.g. Vite's HMR socket, which self-gates on the `vite-hmr` protocol. It never
   * destroys a non-matching socket, so it is safe to attach alongside others.
   */
  handleUpgrade: UpgradeHandler
}

/**
 * Mount WyStack's routes onto a Node http.Server the HOST owns, instead of
 * creating one (`serve`). This is the seam the process-collapse uses: the app
 * shell (TanStack Start, or Vite in dev) and WyStack's WS/REST run in ONE
 * process against ONE `app`, so a write on any surface reaches every live
 * subscription. Two servers/apps would resurrect the split-store bug.
 *
 * HTTP: call `fetch` for `${prefix}/*` requests. WS: attach `handleUpgrade` to
 * `server.on('upgrade', ...)`.
 *
 * The gating trick: `@hono/node-ws`'s own `injectWebSocket` installs a CATCH-ALL
 * upgrade listener that `socket.end()`s any upgrade without a matching ws route —
 * which would kill a co-hosted Vite HMR socket. We hand `injectWebSocket` a bare
 * `EventEmitter` instead of the real server, capture the handler it registers,
 * and invoke it ourselves only for in-prefix upgrades. No internals are
 * reimplemented; the catch-all simply never sees a foreign socket.
 */
export function mountNodeRoutes(opts: RouteOptions & { baseUrl?: string }): MountedRoutes {
  const prefix = opts.prefix ?? '/api'
  const baseUrl = opts.baseUrl ?? 'http://localhost'

  const hono = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: hono, baseUrl })
  const routes = createRoutes(opts, upgradeWebSocket)
  hono.route('/', routes)

  const shim = new EventEmitter()
  injectWebSocket(shim as unknown as HttpServer)
  const honoUpgrade = shim.listeners('upgrade')[0] as UpgradeHandler

  const handleUpgrade: UpgradeHandler = (req, socket, head) => {
    const { pathname } = new URL(req.url ?? '/', baseUrl)
    if (pathname !== `${prefix}/ws`) return
    honoUpgrade(req, socket, head)
  }

  // overrideGlobalObjects:false — a mount embedded in a HOST process must not
  // monkeypatch `global.Request`/`global.Response`. @hono/node-server otherwise
  // installs its own "lightweight Response" as the global (a lazy-Response perf
  // optimization for its own listener); once global, that class breaks any
  // co-resident Bun.serve, whose native side rejects it ("Expected a Response
  // object"). We give up node-server's micro-optimization to stay a good citizen
  // of the runtime (Vite/TanStack Start) that owns these globals.
  const requestListener = getRequestListener(hono.fetch, { overrideGlobalObjects: false })

  return { fetch: hono.fetch as MountedRoutes['fetch'], requestListener, handleUpgrade }
}
