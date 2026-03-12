export interface WyStackClientConfig {
  url: string
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
