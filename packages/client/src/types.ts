import type { ClientContext } from '@wystack/transport'

export interface WyStackClientConfig {
  /** WyStack server URL (e.g., 'http://localhost:3001') */
  url: string
  /** URL prefix matching the server's route prefix. Default: '/api' */
  prefix?: string
  /**
   * App-provided function to get auth token. Called per HTTP request. Also
   * called before WS connect unless `requiresAuth` is explicitly `false`.
   */
  getToken?: () => Promise<string | null> | string | null
  /**
   * App-provided JSON context. Called for every HTTP request and authenticated
   * WebSocket connection attempt, then validated by the server. Use `getToken`
   * for Authorization; client context never becomes request headers.
   */
  getContext?: () => Promise<ClientContext> | ClientContext
  /**
   * Whether the WebSocket transport must perform the auth handshake.
   *
   * Defaults to true when `getToken` or `getContext` is provided and false
   * otherwise. Set false for trusted transports such as in-process IPC or
   * same-process local runtime usage where HTTP may still use either callback
   * but WS must not send auth frames.
   */
  requiresAuth?: boolean
}
