import type { UpgradeWebSocket, WSContext } from 'hono/ws'
import type { WyStackApp } from '../create'
import { ValidationError } from '../validation'
import { createAuthHandlers } from './auth'
import { buildAuthRequest, errorMessage, parseClientMessage, safeSend } from './helpers'
import { createSubscriptionHandlers } from './subscriptions'
import type { RawConnections, ResolveContext, SubSockets } from './types'

interface WebSocketRouteOptions {
  app: WyStackApp
  upgradeWebSocket: UpgradeWebSocket
  requiresAuth: boolean
  resolveContext: ResolveContext
  authTimeoutMs: number
  subToWs: SubSockets
}

export function createWebSocketRoute({
  app,
  upgradeWebSocket,
  requiresAuth,
  resolveContext,
  authTimeoutMs,
  subToWs,
}: WebSocketRouteOptions) {
  const rawToConnection: RawConnections = new Map()
  const keyOf = (ws: WSContext): object => ws.raw as object

  async function resolveSubContext(
    rawSocket: object,
    token: string | null,
  ): Promise<Record<string, unknown>> {
    const conn = rawToConnection.get(rawSocket)
    if (!conn) throw new Error('connection not registered')
    return (await resolveContext(buildAuthRequest(conn.upgradeRequest, token))) ?? {}
  }

  const { handleAuthFrame } = createAuthHandlers({ rawToConnection, resolveSubContext })
  const { handleSubscribe, handleUnsubscribe, removeAllForSocket } = createSubscriptionHandlers({
    app,
    rawToConnection,
    subToWs,
    keyOf,
    resolveSubContext,
  })

  return upgradeWebSocket((c) => {
    const upgradeRequest = c.req.raw
    return {
      onOpen(_evt, ws) {
        const timeout = requiresAuth
          ? setTimeout(() => ws.close(4002, 'auth timeout'), authTimeoutMs)
          : null
        rawToConnection.set(keyOf(ws), {
          authenticated: !requiresAuth,
          token: null,
          upgradeRequest,
          timeout,
          subIds: new Set(),
          pendingSubIds: new Set(),
        })
      },

      async onMessage(event, ws) {
        const rawSocket = keyOf(ws)
        const conn = rawToConnection.get(rawSocket)
        if (!conn) {
          ws.close(4001, 'no connection state')
          return
        }

        const msg = parseClientMessage(String(event.data))
        if (msg === null) {
          if (!conn.authenticated) {
            ws.close(4001, 'invalid first message')
            return
          }
          safeSend(ws, { type: 'error', error: 'invalid message' })
          return
        }

        if (msg.type === 'auth') {
          await handleAuthFrame(msg, ws, conn, rawSocket)
          return
        }

        if (!conn.authenticated) {
          ws.close(4001, 'first message must be auth')
          return
        }

        let msgId: string | undefined
        try {
          msgId = msg.id as string | undefined

          // Filed: TASK-490 - scope subscription IDs per-socket to prevent cross-socket collision.
          if (msg.type === 'subscribe') {
            await handleSubscribe(msg, ws, conn, rawSocket)
            return
          }

          if (msg.type === 'unsubscribe') {
            handleUnsubscribe(msg, ws, conn)
            return
          }

          safeSend(ws, {
            type: 'error',
            id: typeof msg.id === 'string' ? msg.id : undefined,
            error: `unknown message type: ${String(msg.type)}`,
          })
        } catch (err: unknown) {
          const payload: Record<string, unknown> = { type: 'error', error: errorMessage(err) }
          if (err instanceof ValidationError) payload.issues = err.issues
          if (msgId) payload.id = msgId
          safeSend(ws, payload)
        }
      },

      onClose(_evt, ws) {
        removeAllForSocket(ws)
      },
    }
  })
}
