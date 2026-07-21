import type { Principal } from '@wystack/identity'
import { isPrincipal } from '@wystack/identity'
import type { AnyColumnDef } from '@wystack/db'
import { assertPermission, evaluate, type Permission } from '@wystack/permissions'
import {
  stageOkBrand,
  type InferArgs,
  type MiddlewareFn,
  type MutationDef,
  type Overwrite,
  type QueryDef,
  type StageOk,
} from './types'

// oxlint-disable-next-line typescript/no-explicit-any -- middleware stages deliberately change context shape
type AnyMiddleware = MiddlewareFn<any, any>

export interface ProcedureBuilder<
  TContext,
  TArgSchema extends Record<string, AnyColumnDef> = Record<never, never>,
> {
  use<TPatch>(
    middleware: MiddlewareFn<TContext, TPatch>,
  ): ProcedureBuilder<Overwrite<TContext, TPatch>, TArgSchema>
  authorize(
    permission: Permission<NoInfer<TContext>>,
  ): ProcedureBuilder<Overwrite<TContext, { principal: Principal }>, TArgSchema>
  input<TNextArgSchema extends Record<string, AnyColumnDef>>(
    schema: TNextArgSchema,
  ): ProcedureBuilder<TContext, TNextArgSchema>
  query<TReturn>(
    handler: (ctx: TContext, args: InferArgs<TArgSchema>) => Promise<TReturn>,
  ): QueryDef<InferArgs<TArgSchema>, TReturn>
  mutation<TReturn>(
    handler: (ctx: TContext, args: InferArgs<TArgSchema>) => Promise<TReturn>,
  ): MutationDef<InferArgs<TArgSchema>, TReturn>
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

function terminal<TContext, TArgSchema extends Record<string, AnyColumnDef>, TReturn>(
  type: 'query' | 'mutation',
  args: TArgSchema,
  middleware: readonly AnyMiddleware[],
  handler: (ctx: TContext, args: InferArgs<TArgSchema>) => Promise<TReturn>,
): QueryDef<InferArgs<TArgSchema>, TReturn> | MutationDef<InferArgs<TArgSchema>, TReturn> {
  return {
    type,
    path: '',
    args,
    // Keep the stored context deliberately broad: client inference only needs
    // FunctionDef assignability, while the builder type-checks the user handler.
    // oxlint-disable-next-line typescript/no-explicit-any -- load-bearing public FunctionDef shape
    async handler(ctx: any, validatedArgs: InferArgs<TArgSchema>): Promise<TReturn> {
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

      return handler(currentContext, validatedArgs)
    },
  }
}

export function createProcedure<TContext>(): ProcedureBuilder<TContext> {
  function createBuilder<TCurrentContext, TArgSchema extends Record<string, AnyColumnDef>>(
    middleware: readonly AnyMiddleware[],
    args: TArgSchema,
  ): ProcedureBuilder<TCurrentContext, TArgSchema> {
    return {
      use<TPatch>(stage: MiddlewareFn<TCurrentContext, TPatch>) {
        return createBuilder<Overwrite<TCurrentContext, TPatch>, TArgSchema>(
          [...middleware, stage],
          args,
        )
      },
      authorize(permission: Permission<NoInfer<TCurrentContext>>) {
        return createBuilder<Overwrite<TCurrentContext, { principal: Principal }>, TArgSchema>(
          [...middleware, authorize<TCurrentContext>(permission)],
          args,
        )
      },
      input<TNextArgSchema extends Record<string, AnyColumnDef>>(schema: TNextArgSchema) {
        return createBuilder<TCurrentContext, TNextArgSchema>(middleware, schema)
      },
      query<TReturn>(
        handler: (ctx: TCurrentContext, handlerArgs: InferArgs<TArgSchema>) => Promise<TReturn>,
      ) {
        return terminal('query', args, middleware, handler) as QueryDef<
          InferArgs<TArgSchema>,
          TReturn
        >
      },
      mutation<TReturn>(
        handler: (ctx: TCurrentContext, handlerArgs: InferArgs<TArgSchema>) => Promise<TReturn>,
      ) {
        return terminal('mutation', args, middleware, handler) as MutationDef<
          InferArgs<TArgSchema>,
          TReturn
        >
      },
    }
  }

  return createBuilder<TContext, Record<never, never>>([], {})
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

export const requireAuth: MiddlewareFn<unknown, { principal: Principal }> = ({ ctx, next }) => {
  const principal = (ctx as { principal?: unknown }).principal
  if (!isPrincipal(principal)) throw new Error('Authentication required')
  return next({ principal })
}
