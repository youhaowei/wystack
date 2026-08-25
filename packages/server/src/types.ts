import type {
  DrizzleTracker,
  AnyColumnDef,
  ColumnDef,
  InferColumn,
  DbConfig,
  TransactionOptions,
} from '@wystack/db'
import type { Permission } from '@wystack/permissions'

/** Replaces properties in T with the corresponding properties from U. */
export type Overwrite<T, U> = Omit<T, keyof U> & U

/** The only value a middleware stage may return to continue the procedure. */
export const stageOkBrand: unique symbol = Symbol('StageOk')

export interface StageOk<TPatch> {
  readonly [stageOkBrand]: true
  readonly patch: TPatch
}

export type MiddlewareFn<TCtxIn, TPatch> = (opts: {
  ctx: TCtxIn
  next: <P = {}>(patch?: P) => StageOk<P>
}) => StageOk<TPatch> | Promise<StageOk<TPatch>>

/** Boolean permission probe: denials return false; policy errors propagate. */
// oxlint-disable-next-line typescript/no-explicit-any -- permissions remain contravariant over app-specific contexts
export type Can = (permission: Permission<any>) => Promise<boolean>

/** Database surface available to application procedures. Tenant/draft binding,
 * raw SQL, and tracking sets remain framework custody. */
export type ProcedureDb = Pick<DrizzleTracker, 'from' | 'into'> & {
  transaction<R>(fn: (tx: ProcedureDb) => Promise<R>, opts?: TransactionOptions): Promise<R>
}

/** Function context passed to every query/mutation/action handler. */
export type FunctionContext<TAppContext extends object = Record<string, unknown>> = TAppContext & {
  db: ProcedureDb
  can: Can
}

/**
 * Maps a DSL ColumnDef to its TypeScript arg type, honoring optionality:
 * `text.optional()` becomes `T | undefined`, not a required `T`. Delegates to
 * `@wystack/db`'s `InferColumn` so column-type inference has a single source of
 * truth (the DSL package owns the ColumnDef optional-flag convention).
 */
export type InferArg<C> = InferColumn<C>

/** True when a ColumnDef carries the optional flag (`.optional()`). */
type IsOptionalColumn<C> = C extends ColumnDef<unknown, infer Opt, boolean> ? Opt : false

/**
 * Maps a table of DSL columns to a procedure's arg object, honoring optionality
 * at the KEY level: `.optional()` columns become omittable (`key?`), not merely
 * `key: T | undefined`. This lets callers pass `{ id, ...partial }` or omit an
 * optional arg entirely, matching what runtime validation already accepts —
 * without an escape hatch that erases the arg type.
 */
export type InferArgs<T extends Record<string, AnyColumnDef>> = {
  [K in keyof T as IsOptionalColumn<T[K]> extends true ? never : K]: InferArg<T[K]>
} & {
  [K in keyof T as IsOptionalColumn<T[K]> extends true ? K : never]?: InferArg<T[K]>
}

// oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
export interface QueryDef<TArgs = any, TReturn = any> {
  type: 'query'
  path: string
  args: Record<string, AnyColumnDef>
  // oxlint-disable-next-line typescript/no-explicit-any -- load-bearing FunctionDef storage shape
  handler: (ctx: any, args: TArgs) => Promise<TReturn>
}

export interface ActionDef<
  // oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
  TArgs = any,
  // oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
  TReturn = any,
  TType extends 'action' | 'mutation' = 'action',
> {
  type: TType
  path: string
  args: Record<string, AnyColumnDef>
  // oxlint-disable-next-line typescript/no-explicit-any -- load-bearing FunctionDef storage shape
  handler: (ctx: any, args: TArgs) => Promise<TReturn>
}

// A Mutation is the transaction-eligible database-write specialization of Action.
// oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
export interface MutationDef<TArgs = any, TReturn = any> extends ActionDef<
  TArgs,
  TReturn,
  'mutation'
> {}

export type FunctionDef = QueryDef | MutationDef | ActionDef

/** DB connection input — string URL, config object, or pre-built Drizzle instance (for tests) */
export type DbInput = string | DbConfig | object

export interface WyStackServer {
  /**
   * The bound port. Only meaningful once `ready` has resolved.
   *
   * Bun binds synchronously, so under `serve-bun` this is correct the instant
   * `serve()` returns. Node does not: `@hono/node-server` reports the assigned
   * port in an asynchronous `listening` callback, so with `port: 0` (ephemeral)
   * this reads `0` until that callback runs. Await `ready` before building a
   * URL from it if the port might be ephemeral.
   */
  port: number
  /**
   * Resolves once the server is listening and `port` is accurate; rejects if
   * binding fails (e.g. the port is already in use) or if `stop()` is called
   * before binding completes (shutdown racing initialization).
   *
   * Exists because the two runtimes disagree on when binding completes — this
   * is the seam that lets a caller be correct on both without branching.
   */
  ready: Promise<void>
  stop(immediate?: boolean): void
}
