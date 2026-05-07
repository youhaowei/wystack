import type { WSContext } from 'hono/ws'

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Send JSON over a WS, swallowing the post-close throw. Outbound frames race
 * against unrelated closes; collapsing the try/catch keeps handlers linear.
 */
export function safeSend(ws: WSContext, payload: unknown): void {
  try {
    ws.send(JSON.stringify(payload))
  } catch {
    /* socket closed */
  }
}

/**
 * Build the synthetic `Request` passed to `resolveContext` for a WS subscribe.
 *
 * When `token` is a non-empty string, layers `Authorization: Bearer ${token}`
 * over the upgrade request's headers. When `token` is `null` (anonymous),
 * strips any inherited Authorization header so the WS auth frame is the sole
 * identity source. Exported through `../routes` for direct invariant tests.
 */
export function buildAuthRequest(upgradeRequest: Request, token: string | null): Request {
  const headers = new Headers(upgradeRequest.headers)
  if (token !== null && token.length > 0) {
    headers.set('authorization', `Bearer ${token}`)
  } else {
    headers.delete('authorization')
  }
  return new Request(upgradeRequest.url, {
    method: upgradeRequest.method,
    headers,
  })
}

/**
 * Parse a client WS frame as a plain object. Rejects non-object JSON and
 * non-string `type` up front so downstream dispatch stays shape-safe.
 */
export function parseClientMessage(data: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const msg = parsed as Record<string, unknown>
  if (typeof msg.type !== 'string') return null
  return msg
}
