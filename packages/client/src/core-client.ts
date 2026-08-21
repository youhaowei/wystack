import type { ActionRef, MutationRef, QueryRef, RefArgs, RefReturn } from './refs.js'

export type LiveUpdatesErrorHandler = (error: Error) => void

export interface ActionOptions {
  signal?: AbortSignal
}

/**
 * Transport-neutral client contract consumed by the React bindings.
 *
 * Platform clients own their connection lifecycle and subscription IDs. React
 * only needs a cleanup function, so WebSocket and IPC details do not leak into
 * shared hooks. Implementations must make calls safe before React's connection
 * effect completes, either by buffering or by managing readiness internally.
 */
export interface Client {
  connect(): void
  disconnect(): void
  subscribe(
    path: string,
    args: Record<string, unknown>,
    onInvalidate: () => void,
    onError?: LiveUpdatesErrorHandler,
  ): () => void
  query<TRef extends QueryRef>(ref: TRef, args?: RefArgs<TRef>): Promise<RefReturn<TRef>>
  mutate<TRef extends MutationRef>(ref: TRef, args?: RefArgs<TRef>): Promise<RefReturn<TRef>>
  action<TRef extends ActionRef>(
    ref: TRef,
    args?: RefArgs<TRef>,
    options?: ActionOptions,
  ): Promise<RefReturn<TRef>>
}
