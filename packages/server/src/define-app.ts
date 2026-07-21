import type { DrizzleTracker } from '@wystack/db'
import { buildWyStack } from './create'
import { authorize, createProcedure, requireAuth } from './functions'
import type { DbInput, FunctionContext, FunctionDef } from './types'

export type ContextFactory<TAppContext> = (
  request: Request,
  services: { db: DrizzleTracker },
) => TAppContext | Promise<TAppContext>

export interface DefineAppOptions<TAppContext> {
  permissions: unknown
  context?: ContextFactory<TAppContext>
}

export interface BuildOptions {
  db: DbInput
  dialect?: 'postgres'
  functions: Record<string, FunctionDef>
  expectedPermissionIds?: readonly string[]
}

export function defineApp<TAppContext extends object>(opts: DefineAppOptions<TAppContext>) {
  return {
    procedure: createProcedure<FunctionContext<TAppContext>>(),
    authorize,
    requireAuth,
    resolveContext: opts.context,
    build(buildOptions: BuildOptions) {
      return buildWyStack({
        ...buildOptions,
        permissions: opts.permissions,
      })
    },
  }
}
