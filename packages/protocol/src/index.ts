// @wystack/protocol
// Shared wire protocol message types for WyStack transports.

export type AuthFrame = {
  type: 'auth'
  token?: string | null
}

export type SubscribeFrame = {
  type: 'subscribe'
  id: string
  path: string
  args?: unknown
}

export type UnsubscribeFrame = {
  type: 'unsubscribe'
  id: string
}

export type ClientFrame = AuthFrame | SubscribeFrame | UnsubscribeFrame

export type AuthenticatedFrame = {
  type: 'authenticated'
}

export type SubscribedFrame = {
  type: 'subscribed'
  id: string
}

export type InvalidateFrame = {
  type: 'invalidate'
  id: string
}

export type ErrorFrame = {
  type: 'error'
  id?: string
  error: string
  issues?: unknown
}

export type ServerFrame = AuthenticatedFrame | SubscribedFrame | InvalidateFrame | ErrorFrame

export type WsCloseCode = 4001 | 4002

export const WS_CLOSE_AUTH_FAILED: WsCloseCode = 4001
export const WS_CLOSE_TRANSIENT: WsCloseCode = 4002
