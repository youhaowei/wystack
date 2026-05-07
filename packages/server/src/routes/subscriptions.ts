import type { WSContext } from 'hono/ws'
import type { WyStackApp } from '../create'
import { ValidationError } from '../validation'
import { errorMessage, safeSend } from './helpers'
import type { Connection, RawConnections, SubSockets } from './types'

interface SubscriptionHandlersOptions {
  app: WyStackApp
  rawToConnection: RawConnections
  subToWs: SubSockets
  keyOf: (ws: WSContext) => object
  resolveSubContext: (rawSocket: object, token: string | null) => Promise<Record<string, unknown>>
}

export function createSubscriptionHandlers({
  app,
  rawToConnection,
  subToWs,
  keyOf,
  resolveSubContext,
}: SubscriptionHandlersOptions) {
  function addSub(id: string, ws: WSContext): void {
    subToWs.set(id, ws)
    const conn = rawToConnection.get(keyOf(ws))
    if (conn) conn.subIds.add(id)
  }

  function removeSub(id: string, ws: WSContext): void {
    app.subscriptions.remove(id)
    subToWs.delete(id)
    rawToConnection.get(keyOf(ws))?.subIds.delete(id)
  }

  function removeAllForSocket(ws: WSContext): void {
    const conn = rawToConnection.get(keyOf(ws))
    if (!conn) return
    if (conn.timeout) clearTimeout(conn.timeout)
    for (const id of conn.subIds) {
      app.subscriptions.remove(id)
      subToWs.delete(id)
    }
    conn.pendingSubIds.clear()
    rawToConnection.delete(keyOf(ws))
  }

  /**
   * Handle `{type:"subscribe", id, path, args}` with flag-check cancellation
   * for unsubscribe/close arriving while context or query work is in-flight.
   */
  async function handleSubscribe(
    msg: Record<string, unknown>,
    ws: WSContext,
    conn: Connection,
    rawSocket: object,
  ): Promise<void> {
    if (typeof msg.id !== 'string' || typeof msg.path !== 'string') {
      safeSend(ws, {
        type: 'error',
        id: typeof msg.id === 'string' ? msg.id : undefined,
        error: 'invalid subscribe message',
      })
      return
    }
    const id = msg.id
    const path = msg.path
    const args = (msg.args ?? {}) as Record<string, unknown>
    const fn = app.functions.get(path)
    if (!fn || fn.type !== 'query') {
      safeSend(ws, { type: 'error', id, error: `Unknown query: ${path}` })
      return
    }

    conn.pendingSubIds.add(id)

    let context: Record<string, unknown>
    try {
      context = await resolveSubContext(rawSocket, conn.token)
    } catch (err) {
      conn.pendingSubIds.delete(id)
      safeSend(ws, { type: 'error', id, error: errorMessage(err) })
      return
    }

    if (!conn.pendingSubIds.has(id)) return

    app
      .call(path, args, context)
      .then(({ tablesRead }) => {
        if (!rawToConnection.has(rawSocket) || !conn.pendingSubIds.has(id)) return
        conn.pendingSubIds.delete(id)
        app.subscriptions.add({
          id,
          functionPath: path,
          args,
          context,
          tablesWatched: tablesRead,
        })
        addSub(id, ws)
        safeSend(ws, { type: 'subscribed', id })
      })
      .catch((err: unknown) => {
        conn.pendingSubIds.delete(id)
        const payload: Record<string, unknown> = {
          type: 'error',
          id,
          error: errorMessage(err),
        }
        if (err instanceof ValidationError) payload.issues = err.issues
        safeSend(ws, payload)
      })
  }

  function handleUnsubscribe(msg: Record<string, unknown>, ws: WSContext, conn: Connection): void {
    if (typeof msg.id !== 'string') {
      safeSend(ws, { type: 'error', error: 'invalid unsubscribe message' })
      return
    }
    const subId = msg.id
    conn.pendingSubIds.delete(subId)
    const sub = app.subscriptions.get(subId)
    if (sub) removeSub(subId, ws)
  }

  return { handleSubscribe, handleUnsubscribe, removeAllForSocket }
}

// TODO: serialize invalidation per-subscription to prevent tablesWatched race under concurrent mutations
export async function invalidateSubscriptions(
  app: WyStackApp,
  writtenTables: Set<string>,
  subToWs: SubSockets,
) {
  const affected = app.subscriptions.getAffectedSubscriptions(writtenTables)

  await Promise.allSettled(
    affected.map(async (sub) => {
      const ws = subToWs.get(sub.id)
      if (!ws) return

      try {
        const { tablesRead } = await app.call(sub.functionPath, sub.args, sub.context)
        sub.tablesWatched = tablesRead
      } catch {
        // Keep existing table watches - client will see the error on refetch.
      }

      safeSend(ws, { type: 'invalidate', id: sub.id })
    }),
  )
}
