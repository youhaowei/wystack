import { buildWyStack } from './create'
import { authorize, createProcedure, requireAuth } from './functions'
import type { DbInput, FunctionContext, FunctionDef } from './types'

export interface DefineAppOptions {
  permissions: unknown
}

export interface BuildOptions {
  db: DbInput
  dialect?: 'postgres'
  functions: Record<string, FunctionDef>
  expectedPermissionIds?: readonly string[]
}

export function defineApp<TAppContext extends object = Record<string, unknown>>(
  opts: DefineAppOptions,
) {
  return {
    procedure: createProcedure<FunctionContext<TAppContext>>(),
    authorize,
    requireAuth,
    build(buildOptions: BuildOptions) {
      return buildWyStack({
        ...buildOptions,
        permissions: opts.permissions,
      })
    },
  }
}
