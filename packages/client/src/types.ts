export interface WyStackClientConfig {
  /** WyStack server URL (e.g., 'http://localhost:3001') */
  url: string
  /** URL prefix matching the server's route prefix. Default: '/api' */
  prefix?: string
  /** App-provided function to get auth token. Called per HTTP request and on WS connect. */
  getToken?: () => Promise<string | null> | string | null
}
