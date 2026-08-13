/**
 * Phantom-branded function references.
 *
 * A ref is just { _path: string } at runtime, but TypeScript sees the full
 * arg/return signature via phantom type parameters. Refs are data — they can
 * be passed as props, stored in config, or used outside React.
 */
// ---------------------------------------------------------------------------
// Phantom brands — never exist at runtime, only in the type system
// ---------------------------------------------------------------------------

declare const QueryBrand: unique symbol
declare const MutationBrand: unique symbol
declare const ActionBrand: unique symbol

/** A typed reference to a server query. Carries arg/return types at compile time. */
export interface QueryRef<TArgs = unknown, TReturn = unknown> {
  readonly _path: string
  readonly [QueryBrand]: { args: TArgs; return: TReturn }
}

/** A typed reference to a server mutation. Carries arg/return types at compile time. */
export interface MutationRef<TArgs = unknown, TReturn = unknown> {
  readonly _path: string
  readonly [MutationBrand]: { args: TArgs; return: TReturn }
}

/** A typed reference to a non-reactive server action. */
export interface ActionRef<TArgs = unknown, TReturn = unknown> {
  readonly _path: string
  readonly [ActionBrand]: { args: TArgs; return: TReturn }
}

/** Union of all function reference types. */
export type FunctionRef = QueryRef | MutationRef | ActionRef

// ---------------------------------------------------------------------------
// Type utilities — extract args/return from refs
// ---------------------------------------------------------------------------

/** Extract the args type from a function reference. */
export type RefArgs<T extends FunctionRef> =
  T extends QueryRef<infer A, unknown>
    ? A
    : T extends MutationRef<infer A, unknown>
      ? A
      : T extends ActionRef<infer A, unknown>
        ? A
        : never

/** Extract the return type from a function reference. */
export type RefReturn<T extends FunctionRef> =
  T extends QueryRef<unknown, infer R>
    ? R
    : T extends MutationRef<unknown, infer R>
      ? R
      : T extends ActionRef<unknown, infer R>
        ? R
        : never

/** Portable structural shape shared by client-side function registries. */
export interface FunctionDefinition {
  readonly type: 'query' | 'mutation' | 'action'
  readonly handler: (...parameters: never[]) => unknown
}

// ---------------------------------------------------------------------------
// Mapped type — converts server function registry to client api object
// ---------------------------------------------------------------------------

type DefinitionArgs<T> = T extends {
  handler: (...parameters: infer TParameters) => unknown
}
  ? TParameters[1]
  : never

type DefinitionReturn<T> = T extends {
  handler: (...parameters: infer _TParameters) => infer TReturn
}
  ? Awaited<TReturn>
  : never

type ToRef<T> = T extends { type: 'query' }
  ? QueryRef<DefinitionArgs<T>, DefinitionReturn<T>>
  : T extends { type: 'mutation' }
    ? MutationRef<DefinitionArgs<T>, DefinitionReturn<T>>
    : T extends { type: 'action' }
      ? ActionRef<DefinitionArgs<T>, DefinitionReturn<T>>
      : never

/** Maps a server function registry `{ listTodos: QueryDef<A,R>, ... }` to `{ listTodos: QueryRef<A,R>, ... }`. */
export type ApiFromFunctions<T extends Record<string, FunctionDefinition>> = {
  [K in keyof T]: ToRef<T[K]>
}
