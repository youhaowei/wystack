import { buildWyStack } from './create'
import { authorize, createProcedure, requireAuth } from './functions'
import type { MultiTenantDescriptor, TenantKeyDefinition } from '@wystack/db'
import type { DbInput, FunctionContext, FunctionDef, LegacyFunctionContext } from './types'

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
    /**
     * Explicit migration surface for existing handlers that still require raw
     * Drizzle queries and manual reactive tracking. Legacy procedures cannot be
     * recorded or replayed as commands; new code should use `procedure`.
     */
    legacyProcedure: createProcedure<LegacyFunctionContext<TAppContext>>('legacy-raw'),
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
