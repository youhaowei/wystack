import type { WyStackClientConfig } from './types'

/**
 * Create a WyStack client instance that manages the connection
 * to the server and local TanStack DB cache.
 */
export function createWyStackClient(config: WyStackClientConfig) {
  return {
    url: config.url,
    mode: config.mode ?? 'local-first',
  }
}

/**
 * React context provider. Wrap your app to enable useQuery/useMutation.
 * TODO: Implement as React context with TanStack QueryClientProvider
 */
export function WyStackProvider(_props: { client: ReturnType<typeof createWyStackClient>; children: any }) {
  // TODO: React context + QueryClientProvider
  throw new Error('Not yet implemented')
}
