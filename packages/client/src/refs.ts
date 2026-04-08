/**
 * Phantom-branded function references.
 *
 * A ref is just { _path: string } at runtime, but TypeScript sees the full
 * arg/return signature via phantom type parameters. Refs are data — they can
 * be passed as props, stored in config, or used outside React.
 */
import type { QueryDef, MutationDef, FunctionDef } from '@wystack/server'

// ---------------------------------------------------------------------------
// Phantom brands — never exist at runtime, only in the type system
// ---------------------------------------------------------------------------

declare const QueryBrand: unique symbol
declare const MutationBrand: unique symbol

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

/** Union of all function reference types. */
export type FunctionRef = QueryRef | MutationRef

// ---------------------------------------------------------------------------
// Type utilities — extract args/return from refs
// ---------------------------------------------------------------------------

/** Extract the args type from a function reference. */
export type RefArgs<T extends FunctionRef> =
  T extends QueryRef<infer A, unknown> ? A : T extends MutationRef<infer A, unknown> ? A : never

/** Extract the return type from a function reference. */
export type RefReturn<T extends FunctionRef> =
  T extends QueryRef<unknown, infer R> ? R : T extends MutationRef<unknown, infer R> ? R : never

// ---------------------------------------------------------------------------
// Mapped type — converts server function registry to client api object
// ---------------------------------------------------------------------------

/* oxlint-disable typescript/no-explicit-any -- `any` needed for conditional type variance matching */
type ToRef<T> =
  T extends QueryDef<infer A, infer R>
    ? QueryRef<A, R>
    : T extends MutationDef<infer A, infer R>
      ? MutationRef<A, R>
      : never
/* oxlint-enable typescript/no-explicit-any */

/** Maps a server function registry `{ listTodos: QueryDef<A,R>, ... }` to `{ listTodos: QueryRef<A,R>, ... }`. */
export type ApiFromFunctions<T extends Record<string, FunctionDef>> = {
  [K in keyof T]: ToRef<T[K]>
}
