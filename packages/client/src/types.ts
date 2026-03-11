export interface WyStackClientConfig {
  url: string
  mode?: 'local-first' | 'server'
}

export interface UseQueryResult<T> {
  data: T | undefined
  isLoading: boolean
  error: Error | null
}
