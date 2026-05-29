/**
 * Hono route definitions for WyStack transport.
 *
 * Routes (default prefix /api):
 *   GET  /api/:fn?args=...  - queries
 *   POST /api/:fn           - mutations
 *   WS   /api/ws            - engine over a Hono WebSocket Pipe
 */
import { Hono } from 'hono'
import type { UpgradeWebSocket, WSContext } from 'hono/ws'
import type { Pipe } from '@wystack/transport'
import type { ServerMessage } from '@wystack/transport'
import type { WyStackApp } from './create'
import {
  attachEngine,
  buildAuthRequest,
  createDispatch,
  createReactiveTier,
  type CloseReason,
  type EngineHandle,
} from './engine'
import { ValidationError } from './validation'

export { buildAuthRequest }

export interface RouteOptions {
  app: WyStackApp
  /** URL prefix for all routes. Default: '/api' */
  prefix?: string
  resolveContext?: (req: Request) => Promise<Record<string, unknown>>
  /**
   * Max ms to wait for the WS auth handshake message after connect.
   * Only applies when `resolveContext` is configured. Default: 10_000.
   */
  authTimeoutMs?: number
}

interface HonoWebSocketPipe extends Pipe<unknown, ServerMessage> {
  receive(message: unknown): void
  markClosed(): void
  closeWith(code: number, reason: string): void
}

interface WebSocketConnection {
  pipe: HonoWebSocketPipe
  handle: EngineHandle
}

let nextPipeId = 0

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function closeCodeFor(reason: CloseReason): number {
  return reason === 'auth-failed' ? 4001 : 4002
}

function closeTextFor(reason: CloseReason): string {
  return reason === 'auth-failed' ? 'auth failed' : 'transient'
}

function createWebSocketPipe(ws: WSContext): HonoWebSocketPipe {
  const id = `hono-ws-${++nextPipeId}`
  const handlers = new Set<(message: unknown) => void>()
  let closed = false

  function closeSocket(code?: number, reason?: string): void {
    if (closed) return
    closed = true
    handlers.clear()
    try {
      if (code !== undefined) {
        ws.close(code, reason)
      } else {
        ws.close()
      }
    } catch {
      /* socket already closed */
    }
  }

  return {
    id,

    send(message) {
      if (closed) return
      ws.send(JSON.stringify(message))
    },

    onMessage(handler) {
      if (closed) return () => {}
      handlers.add(handler)
      let active = true
      return () => {
        if (!active) return
        active = false
        handlers.delete(handler)
      }
    },

    close() {
      closeSocket()
    },

    closeWith(code, reason) {
      closeSocket(code, reason)
    },

    markClosed() {
      closed = true
      handlers.clear()
    },

    receive(message) {
      if (closed) return
      for (const handler of [...handlers]) handler(message)
    },
  }
}

export function createRoutes(opts: RouteOptions, upgradeWebSocket: UpgradeWebSocket) {
  const { app, prefix = '/api' } = opts
  const resolveContext = opts.resolveContext ?? (async () => ({}))
  const authTimeoutMs = opts.authTimeoutMs ?? 10_000
  const dispatch = createDispatch(app)
  const reactive = createReactiveTier(app)
  const hono = new Hono()
  const rawToConnection = new Map<object, WebSocketConnection>()

  // Hono types `ws.raw` as `unknown`; in practice it is the platform socket.
  const keyOf = (ws: WSContext): object => ws.raw as object

  // WebSocket is registered before /:fn to avoid the param catch.
  hono.get(
    `${prefix}/ws`,
    upgradeWebSocket((c) => {
      const upgradeRequest = c.req.raw
      return {
        onOpen(_evt, ws) {
          const pipe = createWebSocketPipe(ws)
          const handle = attachEngine(pipe, {
            app,
            reactive,
            baseRequest: upgradeRequest,
            authTimeoutMs,
            resolveContext: opts.resolveContext,
            onClose(reason) {
              pipe.closeWith(closeCodeFor(reason), closeTextFor(reason))
            },
          })
          rawToConnection.set(keyOf(ws), { pipe, handle })
        },

        onMessage(event, ws) {
          const conn = rawToConnection.get(keyOf(ws))
          if (!conn) {
            ws.close(4001, 'no connection state')
            return
          }
          conn.pipe.receive(event.data)
        },

        onClose(_evt, ws) {
          const conn = rawToConnection.get(keyOf(ws))
          if (!conn) return
          rawToConnection.delete(keyOf(ws))
          conn.pipe.markClosed()
          conn.handle.detach()
        },
      }
    }),
  )

  hono.get(`${prefix}/:fn`, async (c) => {
    const functionPath = c.req.param('fn')
    const fn = app.functions.get(functionPath)

    if (!fn) {
      return c.json({ error: `Unknown function: ${functionPath}` }, 404)
    }

    if (fn.type !== 'query') {
      return c.json({ error: `${functionPath} is a mutation — use POST` }, 405)
    }

    let context: Record<string, unknown>
    try {
      context = await resolveContext(c.req.raw)
    } catch (err: unknown) {
      return c.json({ error: errorMessage(err) }, 401)
    }

    const argsParam = c.req.query('args')
    let args: unknown = {}
    if (argsParam) {
      try {
        args = JSON.parse(argsParam)
      } catch {
        return c.json({ error: 'Invalid JSON in args parameter' }, 400)
      }
    }

    try {
      const { result } = await dispatch(functionPath, args, context)
      return c.json({ data: result })
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        return c.json({ error: err.message, issues: err.issues }, 400)
      }
      return c.json({ error: errorMessage(err) }, 500)
    }
  })

  hono.post(`${prefix}/:fn`, async (c) => {
    const functionPath = c.req.param('fn')
    const fn = app.functions.get(functionPath)

    if (!fn) {
      return c.json({ error: `Unknown function: ${functionPath}` }, 404)
    }

    if (fn.type !== 'mutation') {
      return c.json({ error: `${functionPath} is a query — use GET` }, 405)
    }

    let context: Record<string, unknown>
    try {
      context = await resolveContext(c.req.raw)
    } catch (err: unknown) {
      return c.json({ error: errorMessage(err) }, 401)
    }

    let body: unknown = {}
    const rawText = await c.req.text()
    if (rawText.trim()) {
      try {
        body = JSON.parse(rawText)
      } catch {
        return c.json({ error: 'Invalid JSON in request body' }, 400)
      }
    }

    try {
      const callResult = await dispatch(functionPath, body, context)
      if (callResult.tablesWritten.size > 0) {
        await reactive.invalidate(callResult.tablesWritten)
      }
      return c.json({ data: callResult.result })
    } catch (err: unknown) {
      if (err instanceof ValidationError) {
        return c.json({ error: err.message, issues: err.issues }, 400)
      }
      return c.json({ error: errorMessage(err) }, 500)
    }
  })

  return hono
}
