import type {
  DrizzleTracker,
  SelectBuilder,
  InsertBuilder,
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

type FrameworkContextPatch = {
  readonly db?: never
  readonly can?: never
}

export type MiddlewareFn<TCtxIn, TPatch> = (opts: {
  readonly ctx: Readonly<TCtxIn>
  next: <P extends object = {}>(patch?: P & FrameworkContextPatch) => StageOk<P>
}) => StageOk<TPatch> | Promise<StageOk<TPatch>>

/** Boolean permission probe: denials return false; policy errors propagate. */
// oxlint-disable-next-line typescript/no-explicit-any -- permissions remain contravariant over app-specific contexts
export type Can = (permission: Permission<any>) => Promise<boolean>

export const procedureSelectChainedMethods = [
  'select',
  'where',
  'includeDeleted',
  'onlyDeleted',
  'orderBy',
  'limit',
] as const
export const procedureSelectTerminalMethods = [
  'all',
  'first',
  'update',
  'delete',
  'softDelete',
  'restore',
  'toSql',
] as const
export const procedureInsertMethods = ['insert'] as const

type ProcedureSelectMethod =
  | (typeof procedureSelectChainedMethods)[number]
  | (typeof procedureSelectTerminalMethods)[number]

type ProcedureTable = Parameters<DrizzleTracker['from']>[0]

export type ProcedureSelectBuilder<T extends ProcedureTable> = Pick<
  SelectBuilder<T>,
  ProcedureSelectMethod
>
export type ProcedureInsertBuilder<T extends ProcedureTable> = Pick<
  InsertBuilder<T>,
  (typeof procedureInsertMethods)[number]
>

/** Database surface available to native application procedures. Tenant/draft binding,
 * raw SQL, and tracking sets remain framework custody. */
export interface ProcedureDb {
  from<T extends ProcedureTable>(table: T): ProcedureSelectBuilder<T>
  into<T extends ProcedureTable>(table: T): ProcedureInsertBuilder<T>
  transaction<R>(fn: (tx: ProcedureDb) => Promise<R>, opts?: TransactionOptions): Promise<R>
}

/**
 * Database surface available to replayable command handlers. The lifecycle
 * owns the transaction boundary, so commands cannot open nested transactions.
 */
export type CommandDb = Pick<ProcedureDb, 'from' | 'into'>

/** Preserve app and middleware fields while narrowing a command handler's DB. */
export type CommandContext<TContext> = Overwrite<TContext, { db: CommandDb }>

/**
 * Raw database surface for app-owned SQL boundaries.
 *
 * The raw connection and manual tracking sets support joins, aggregates, and
 * bulk workflows that the native DSL cannot yet express. Trusted tenant
 * resolution and tag qualification remain framework-owned, but raw SQL tenant
 * and soft-delete predicates are application-owned. Tenant and draft
 * scope-changing methods remain framework custody on every raw boundary.
 */
export interface RawProcedureDb extends ProcedureDb {
  readonly raw: DrizzleTracker['raw']
  readonly tablesRead: Set<string>
  readonly tablesWritten: Set<string>
  /** Record an unqualified global-table read; tenant/draft identity prefixes are rejected. */
  trackGlobalRead(tag: string): void
  /** Record an unqualified global-table write; tenant/draft identity prefixes are rejected. */
  trackGlobalWrite(tag: string): void
  transaction<R>(fn: (tx: RawProcedureDb) => Promise<R>, opts?: TransactionOptions): Promise<R>
}

/** Backward-compatible name for the raw legacy migration facade. */
export type LegacyProcedureDb = RawProcedureDb

/**
 * Base context for query, mutation, and action handlers. The command terminal
 * narrows this with `CommandContext` so replayable handlers cannot transact.
 */
export type FunctionContext<TAppContext extends object = Record<string, unknown>> = TAppContext & {
  db: ProcedureDb
  can: Can
}

/** Context shared by explicit raw boundaries after any configured tenant resolution. */
export type RawFunctionContext<TAppContext extends object = Record<string, unknown>> =
  TAppContext & {
    db: RawProcedureDb
    can: Can
  }

/** Context passed only to handlers built with `defineApp().readModel`. */
export type ReadModelFunctionContext<TAppContext extends object = Record<string, unknown>> =
  RawFunctionContext<TAppContext>

/** Context passed only to handlers built with `defineApp().integration`. */
export type IntegrationFunctionContext<TAppContext extends object = Record<string, unknown>> =
  RawFunctionContext<TAppContext>

/** Backward-compatible context for `defineApp().legacyProcedure`. */
export type LegacyFunctionContext<TAppContext extends object = Record<string, unknown>> =
  RawFunctionContext<TAppContext>

/** Runtime marker controlling which database facade a registered handler receives. */
export type ProcedureDatabaseAccess = 'native' | 'read-model-raw' | 'integration-raw' | 'legacy-raw'

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

export interface QueryDef<
  // oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
  TArgs = any,
  // oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
  TReturn = any,
  TDatabaseAccess extends ProcedureDatabaseAccess = ProcedureDatabaseAccess,
> {
  type: 'query'
  databaseAccess: TDatabaseAccess
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
  TDatabaseAccess extends ProcedureDatabaseAccess = ProcedureDatabaseAccess,
> {
  type: TType
  databaseAccess: TDatabaseAccess
  path: string
  args: Record<string, AnyColumnDef>
  // oxlint-disable-next-line typescript/no-explicit-any -- load-bearing FunctionDef storage shape
  handler: (ctx: any, args: TArgs) => Promise<TReturn>
}

// A Mutation is the canonical database-write specialization of Action. It is
// callable through the normal RPC path, but is not draft-replayable by default:
// handlers may rely on canonical-only transaction/orchestration semantics.
// `.command(...)` is the explicit replay-safety attestation for DB-only handlers.
export interface MutationDef<
  // oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
  TArgs = any,
  // oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
  TReturn = any,
  TDraftReplayable extends boolean = boolean,
  TDatabaseAccess extends ProcedureDatabaseAccess = ProcedureDatabaseAccess,
> extends ActionDef<TArgs, TReturn, 'mutation', TDatabaseAccess> {
  /** Capability attestation consumed by applyCommands and the draft lifecycle. */
  draftReplayable: TDraftReplayable
}

/** A mutation whose author explicitly attested it is safe for ordered draft replay. */
// oxlint-disable-next-line typescript/no-explicit-any -- generic defaults need `any` for TypeScript variance compatibility
export type CommandDef<TArgs = any, TReturn = any> = MutationDef<TArgs, TReturn, true, 'native'>

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
