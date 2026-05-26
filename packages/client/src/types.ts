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
   * Whether the WebSocket transport must perform the auth handshake.
   *
   * Defaults to true when `getToken` is provided and false otherwise. Set false
   * for trusted transports such as in-process IPC or same-process local runtime
   * usage where HTTP may still use `getToken` but WS must not send auth frames.
   */
  requiresAuth?: boolean
}
