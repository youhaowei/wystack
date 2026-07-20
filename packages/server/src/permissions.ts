import type { Principal } from '@wystack/identity'
import type { FunctionDef } from './types'

export type CheckPermission = (
  principal: Principal,
  permission: string,
) => boolean | Promise<boolean>

export class PermissionDeniedError extends Error {
  constructor(readonly permission: string) {
    super('Forbidden')
    this.name = 'PermissionDeniedError'
  }
}

export async function assertFunctionPermission(
  fn: FunctionDef,
  context: Record<string, unknown>,
  checkPermission: CheckPermission | undefined,
): Promise<void> {
  if (!fn.permission) return

  // Fail closed on every path: an absent principal, a principal whose kind we
  // don't recognize, an unwired checkPermission, and a falsy check all deny.
  const principal = context.principal as Principal | undefined
  if (
    !principal ||
    (principal.kind !== 'user' && principal.kind !== 'service') ||
    !checkPermission ||
    !(await checkPermission(principal, fn.permission))
  ) {
    throw new PermissionDeniedError(fn.permission)
  }
}
