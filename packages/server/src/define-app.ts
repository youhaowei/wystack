import { buildWyStack } from './create'
import { authorize, createProcedure, requireAuth } from './functions'
import type { MultiTenantDescriptor, TenantKeyDefinition } from '@wystack/db'
import type { DbInput, FunctionContext, FunctionDef } from './types'

export interface DefineAppOptions {
  permissions: unknown
}

export interface BuildOptions {
  db: DbInput
  dialect?: 'postgres'
  functions: Record<string, FunctionDef>
  expectedPermissionIds?: readonly string[]
  /** The descriptor that defines the database identity accepted by resolveTenant. */
  tenancy?: MultiTenantDescriptor<TenantKeyDefinition>
  resolveTenant?: (context: Record<string, unknown>) => unknown | Promise<unknown>
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
