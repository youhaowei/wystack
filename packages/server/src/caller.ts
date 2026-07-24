import type { QueryDef, MutationDef, FunctionDef } from './types'
import type { WyStackApp } from './create'

/** One FunctionDef → its callable signature. Server mirror of client refs.ts ToRef. */
type ToCaller<T> =
  T extends QueryDef<infer A, infer R>
    ? (args: A) => Promise<R>
    : T extends MutationDef<infer A, infer R>
      ? (args: A) => Promise<R>
      : never

/** Maps a function registry to a typed caller object. Server mirror of client's ApiFromFunctions. */
export type CallerFromFunctions<T extends Record<string, FunctionDef>> = {
  [K in keyof T]: ToCaller<T[K]>
}

/**
 * Build a typed caller bound to one request's context. Every registry procedure
 * becomes `caller.procedureName(args)` returning its typed result. Dispatches
 * through `app.call`, discarding the read/write tracking sets — invalidation is
 * the caller's responsibility at the transaction boundary (see `WyStackApp.call`).
 *
 * `T` is supplied explicitly (mirroring `createApi<T>()`) because `WyStackApp`
 * erases the registry to `Map<string, FunctionDef>` at runtime. The single
 * `as CallerFromFunctions<T>` cast is the one load-bearing trust boundary.
 */
export function createCaller<T extends Record<string, FunctionDef>>(
  app: WyStackApp,
  context: Record<string, unknown>,
): CallerFromFunctions<T> {
  const caller: Record<string, (args: never) => Promise<unknown>> = {}
  for (const path of app.functions.keys()) {
    caller[path] = async (args) => {
      const { result } = await app.call(path, args, context)
      return result
    }
  }
  return caller as CallerFromFunctions<T>
}
