export interface WyStackClientConfig {
  url: string
  /** URL prefix matching the server's route prefix. Default: '/api' */
  prefix?: string
}

export interface UseQueryResult<T> {
  data: T | undefined
  isLoading: boolean
  error: Error | null
}

export interface UseMutationResult<TArgs, TReturn> {
  mutate: (args: TArgs) => Promise<TReturn>
  isLoading: boolean
  error: Error | null
}
