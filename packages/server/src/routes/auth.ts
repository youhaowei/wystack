import type { WSContext } from 'hono/ws'
import type { Connection, RawConnections } from './types'
import { errorMessage, safeSend } from './helpers'

interface AuthHandlersOptions {
  rawToConnection: RawConnections
  resolveSubContext: (rawSocket: object, token: string | null) => Promise<Record<string, unknown>>
}

export function createAuthHandlers({ rawToConnection, resolveSubContext }: AuthHandlersOptions) {
  /**
   * Handle an inbound `{type:"auth", token}` frame. Two paths:
   *
   *   1. Unauthenticated -> run resolveContext, then ACK or close 4001.
   *   2. Already authenticated -> idempotent ACK so the client timer stops.
   */
  async function handleAuthFrame(
    msg: Record<string, unknown>,
    ws: WSContext,
    conn: Connection,
    rawSocket: object,
  ): Promise<void> {
    if (conn.authenticated) {
      safeSend(ws, { type: 'authenticated' })
      return
    }

    const rawToken = msg.token
    const token = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null

    try {
      await resolveSubContext(rawSocket, token)
      if (!rawToConnection.has(rawSocket)) return
      if (conn.authenticated) {
        safeSend(ws, { type: 'authenticated' })
        return
      }
      conn.token = token
      if (conn.timeout) clearTimeout(conn.timeout)
      conn.timeout = null
      conn.authenticated = true
      try {
        ws.send(JSON.stringify({ type: 'authenticated' }))
      } catch {
        ws.close(4002, 'ack send failed')
      }
    } catch (err) {
      console.warn('[wystack/server] WS auth failed:', errorMessage(err))
      if (rawToConnection.has(rawSocket) && !conn.authenticated) ws.close(4001, 'auth failed')
    }
  }

  return { handleAuthFrame }
}
