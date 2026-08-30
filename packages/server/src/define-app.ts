import { buildWyStack } from './create'
import { authorize, createProcedure, requireAuth } from './functions'
import type { MultiTenantDescriptor, TenantKeyDefinition } from '@wystack/db'
import type {
  DbInput,
  FunctionContext,
  FunctionDef,
  IntegrationFunctionContext,
  LegacyFunctionContext,
  ReadModelFunctionContext,
} from './types'

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
     * Raw SQL for app-owned joins and aggregates, dispatched after any
     * configured trusted tenant resolution. Manual tags are tenant-qualified
     * when scoped; the handler owns raw SQL tenant predicates. Read models
     * expose only the query terminal.
     */
    readModel: createProcedure<ReadModelFunctionContext<TAppContext>>('read-model-raw'),
    /**
     * Raw SQL for canonical workflows such as bulk import, dispatched after any
     * configured trusted tenant resolution. Manual tags are tenant-qualified
     * when scoped; the handler owns raw SQL tenant predicates. Integrations
     * expose only the mutation terminal.
     */
    integration: createProcedure<IntegrationFunctionContext<TAppContext>>('integration-raw'),
    /**
     * Explicit migration surface for existing handlers that still require raw
     * Drizzle queries and manual reactive tracking. Legacy procedures cannot be
     * recorded or replayed as commands; new code should use `procedure`,
     * `readModel`, or `integration` according to its boundary.
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
