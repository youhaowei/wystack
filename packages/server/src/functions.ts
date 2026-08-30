import type { Principal } from '@wystack/identity'
import { isPrincipal } from '@wystack/identity'
import type { AnyColumnDef } from '@wystack/db'
import { assertPermission, evaluate, type Permission } from '@wystack/permissions'
import {
  stageOkBrand,
  type InferArgs,
  type MiddlewareFn,
  type ActionDef,
  type CommandContext,
  type CommandDef,
  type MutationDef,
  type Overwrite,
  type ProcedureDatabaseAccess,
  type QueryDef,
  type StageOk,
} from './types'
import { buildArgsSchema, ValidationError } from './validation'

// oxlint-disable-next-line typescript/no-explicit-any -- middleware stages deliberately change context shape
type AnyMiddleware = MiddlewareFn<any, any>

type QueryTerminal<
  TContext,
  TArgSchema extends Record<string, AnyColumnDef>,
  TDatabaseAccess extends ProcedureDatabaseAccess,
> = TDatabaseAccess extends 'native' | 'read-model-raw' | 'legacy-raw'
  ? <TReturn>(
      handler: (ctx: TContext, args: InferArgs<TArgSchema>) => Promise<TReturn>,
    ) => QueryDef<InferArgs<TArgSchema>, TReturn, TDatabaseAccess>
  : never

type MutationTerminal<
  TContext,
  TArgSchema extends Record<string, AnyColumnDef>,
  TDatabaseAccess extends ProcedureDatabaseAccess,
> = TDatabaseAccess extends 'native' | 'integration-raw' | 'legacy-raw'
  ? <TReturn>(
      handler: (ctx: TContext, args: InferArgs<TArgSchema>) => Promise<TReturn>,
    ) => MutationDef<InferArgs<TArgSchema>, TReturn, false, TDatabaseAccess>
  : never

type ActionTerminal<
  TContext,
  TArgSchema extends Record<string, AnyColumnDef>,
  TDatabaseAccess extends ProcedureDatabaseAccess,
> = TDatabaseAccess extends 'native' | 'legacy-raw'
  ? <TReturn>(
      handler: (ctx: TContext, args: InferArgs<TArgSchema>) => Promise<TReturn>,
    ) => ActionDef<InferArgs<TArgSchema>, TReturn, 'action', TDatabaseAccess>
  : never

export interface ProcedureBuilder<
  TContext,
  TArgSchema extends Record<string, AnyColumnDef> = Record<never, never>,
  TDatabaseAccess extends ProcedureDatabaseAccess = 'native',
> {
  use<TPatch>(
    middleware: MiddlewareFn<TContext, TPatch>,
  ): ProcedureBuilder<Overwrite<TContext, TPatch>, TArgSchema, TDatabaseAccess>
  authorize(
    permission: Permission<NoInfer<TContext>>,
  ): ProcedureBuilder<Overwrite<TContext, { principal: Principal }>, TArgSchema, TDatabaseAccess>
  input<TNextArgSchema extends Record<string, AnyColumnDef>>(
    schema: TNextArgSchema,
  ): ProcedureBuilder<TContext, TNextArgSchema, TDatabaseAccess>
  query: QueryTerminal<TContext, TArgSchema, TDatabaseAccess>
  mutation: MutationTerminal<TContext, TArgSchema, TDatabaseAccess>
  /**
   * Attest that a native, DB-only handler is safe for ordered draft replay.
   * WyStack restricts the DB surface but cannot inspect captured side effects.
   */
  command: TDatabaseAccess extends 'native'
    ? <TReturn>(
        handler: (ctx: CommandContext<TContext>, args: InferArgs<TArgSchema>) => Promise<TReturn>,
      ) => CommandDef<InferArgs<TArgSchema>, TReturn>
    : never
  action: ActionTerminal<TContext, TArgSchema, TDatabaseAccess>
}

function stageOk<P>(patch?: P): StageOk<P> {
  return {
    [stageOkBrand]: true,
    patch: patch ?? ({} as P),
  }
}

function isStageOk(value: unknown): value is StageOk<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    stageOkBrand in value &&
    value[stageOkBrand] === true
  )
}

function terminal<
  TContext,
  TArgSchema extends Record<string, AnyColumnDef>,
  TReturn,
  TDatabaseAccess extends ProcedureDatabaseAccess,
>(
  type: 'query' | 'mutation' | 'action',
  databaseAccess: TDatabaseAccess,
  draftReplayable: boolean,
  args: TArgSchema,
  middleware: readonly AnyMiddleware[],
  handler: (ctx: TContext, args: InferArgs<TArgSchema>) => Promise<TReturn>,
):
  | QueryDef<InferArgs<TArgSchema>, TReturn, TDatabaseAccess>
  | MutationDef<InferArgs<TArgSchema>, TReturn, boolean, TDatabaseAccess>
  | ActionDef<InferArgs<TArgSchema>, TReturn, 'action', TDatabaseAccess> {
  const argsSchema = buildArgsSchema(args)

  const definition = {
    path: '',
    args,
    // Keep the stored context deliberately broad: client inference only needs
    // FunctionDef assignability, while the builder type-checks the user handler.
    // oxlint-disable-next-line typescript/no-explicit-any -- load-bearing public FunctionDef shape
    async handler(ctx: any, rawArgs: InferArgs<TArgSchema>): Promise<TReturn> {
      let currentContext = ctx

      for (const stage of middleware) {
        const result = await stage({ ctx: currentContext, next: stageOk })
        if (!isStageOk(result)) {
          throw new Error('Middleware must return the value produced by next()')
        }
        const nextContext = { ...currentContext, ...(result.patch as object) }
        // Middleware patches can change permission-relevant context. Rebind
        // the probe to the exact object the next stage and handler receive.
        // oxlint-disable-next-line typescript/no-explicit-any -- app permissions carry app-specific contexts
        nextContext.can = (permission: Permission<any>) =>
          evaluate(nextContext.principal, permission, nextContext)
        currentContext = nextContext
      }

      const parsed = argsSchema.safeParse(rawArgs)
      if (!parsed.success) throw new ValidationError(parsed.error.issues)

      return handler(currentContext, parsed.data as InferArgs<TArgSchema>)
    },
  }

  if (type === 'mutation') {
    return { ...definition, type, databaseAccess, draftReplayable }
  }
  return { ...definition, type, databaseAccess }
}

export function createProcedure<TContext>(
  databaseAccess?: 'native',
): ProcedureBuilder<TContext, Record<never, never>, 'native'>
export function createProcedure<TContext>(
  databaseAccess: 'legacy-raw',
): ProcedureBuilder<TContext, Record<never, never>, 'legacy-raw'>
export function createProcedure<TContext>(
  databaseAccess: 'read-model-raw',
): ProcedureBuilder<TContext, Record<never, never>, 'read-model-raw'>
export function createProcedure<TContext>(
  databaseAccess: 'integration-raw',
): ProcedureBuilder<TContext, Record<never, never>, 'integration-raw'>
export function createProcedure<TContext>(
  databaseAccess: ProcedureDatabaseAccess = 'native',
): ProcedureBuilder<TContext, Record<never, never>, ProcedureDatabaseAccess> {
  function createBuilder<
    TCurrentContext,
    TArgSchema extends Record<string, AnyColumnDef>,
    TCurrentDatabaseAccess extends ProcedureDatabaseAccess,
  >(
    middleware: readonly AnyMiddleware[],
    args: TArgSchema,
    currentDatabaseAccess: TCurrentDatabaseAccess,
  ): ProcedureBuilder<TCurrentContext, TArgSchema, TCurrentDatabaseAccess> {
    return {
      use<TPatch>(stage: MiddlewareFn<TCurrentContext, TPatch>) {
        return createBuilder<
          Overwrite<TCurrentContext, TPatch>,
          TArgSchema,
          TCurrentDatabaseAccess
        >([...middleware, stage], args, currentDatabaseAccess)
      },
      authorize(permission: Permission<NoInfer<TCurrentContext>>) {
        return createBuilder<
          Overwrite<TCurrentContext, { principal: Principal }>,
          TArgSchema,
          TCurrentDatabaseAccess
        >([...middleware, authorize<TCurrentContext>(permission)], args, currentDatabaseAccess)
      },
      input<TNextArgSchema extends Record<string, AnyColumnDef>>(schema: TNextArgSchema) {
        return createBuilder<TCurrentContext, TNextArgSchema, TCurrentDatabaseAccess>(
          middleware,
          schema,
          currentDatabaseAccess,
        )
      },
      query: (currentDatabaseAccess === 'native' ||
      currentDatabaseAccess === 'read-model-raw' ||
      currentDatabaseAccess === 'legacy-raw'
        ? <TReturn>(
            handler: (ctx: TCurrentContext, handlerArgs: InferArgs<TArgSchema>) => Promise<TReturn>,
          ) =>
            terminal('query', currentDatabaseAccess, false, args, middleware, handler) as QueryDef<
              InferArgs<TArgSchema>,
              TReturn,
              TCurrentDatabaseAccess
            >
        : undefined) as ProcedureBuilder<
        TCurrentContext,
        TArgSchema,
        TCurrentDatabaseAccess
      >['query'],
      mutation: (currentDatabaseAccess === 'native' ||
      currentDatabaseAccess === 'integration-raw' ||
      currentDatabaseAccess === 'legacy-raw'
        ? <TReturn>(
            handler: (ctx: TCurrentContext, handlerArgs: InferArgs<TArgSchema>) => Promise<TReturn>,
          ) =>
            terminal(
              'mutation',
              currentDatabaseAccess,
              false,
              args,
              middleware,
              handler,
            ) as MutationDef<InferArgs<TArgSchema>, TReturn, false, TCurrentDatabaseAccess>
        : undefined) as ProcedureBuilder<
        TCurrentContext,
        TArgSchema,
        TCurrentDatabaseAccess
      >['mutation'],
      command: (currentDatabaseAccess === 'native'
        ? <TReturn>(
            handler: (
              ctx: CommandContext<TCurrentContext>,
              handlerArgs: InferArgs<TArgSchema>,
            ) => Promise<TReturn>,
          ) =>
            terminal(
              'mutation',
              currentDatabaseAccess,
              true,
              args,
              middleware,
              handler,
            ) as CommandDef<InferArgs<TArgSchema>, TReturn>
        : undefined) as ProcedureBuilder<
        TCurrentContext,
        TArgSchema,
        TCurrentDatabaseAccess
      >['command'],
      action: (currentDatabaseAccess === 'native' || currentDatabaseAccess === 'legacy-raw'
        ? <TReturn>(
            handler: (ctx: TCurrentContext, handlerArgs: InferArgs<TArgSchema>) => Promise<TReturn>,
          ) =>
            terminal(
              'action',
              currentDatabaseAccess,
              false,
              args,
              middleware,
              handler,
            ) as ActionDef<InferArgs<TArgSchema>, TReturn, 'action', TCurrentDatabaseAccess>
        : undefined) as ProcedureBuilder<
        TCurrentContext,
        TArgSchema,
        TCurrentDatabaseAccess
      >['action'],
    }
  }

  return createBuilder<TContext, Record<never, never>, ProcedureDatabaseAccess>(
    [],
    {},
    databaseAccess,
  )
}

export function authorize<TContext>(
  permission: Permission<TContext>,
): MiddlewareFn<TContext, { principal: Principal }> {
  return async ({ ctx, next }) => {
    const principal = (ctx as { principal?: unknown }).principal
    await assertPermission(principal, permission, ctx)
    return next({ principal: principal as Principal })
  }
}

/**
 * The request carried no usable principal where one was required.
 *
 * Typed rather than a bare `Error` because the transport has to answer 401 for it. An
 * untyped throw falls through every classification branch to the generic handler and
 * becomes a 500 — which tells the client the server broke, when in fact the client
 * simply is not signed in, and buries a routine sign-in prompt in the error budget.
 *
 * Distinct from `PermissionDeniedError` (403 — authenticated, but not allowed) and from
 * `IdentityProviderUnavailableError` (503 — we could not determine either way).
 */
export class AuthenticationRequiredError extends Error {
  override readonly name = 'AuthenticationRequiredError'

  constructor(message = 'Authentication required') {
    super(message)
  }
}

export const requireAuth: MiddlewareFn<unknown, { principal: Principal }> = ({ ctx, next }) => {
  const principal = (ctx as { principal?: unknown }).principal
  if (!isPrincipal(principal)) throw new AuthenticationRequiredError()
  return next({ principal })
}
