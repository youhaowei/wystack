import { isPrincipal } from '@wystack/identity'
import type { Permission } from './permission'

export async function evaluate<TContext>(
  principalCandidate: unknown,
  permission: Permission<TContext>,
  ctx: TContext,
): Promise<boolean> {
  if (!isPrincipal(principalCandidate)) return false
  return (await permission.check({ ...ctx, principal: principalCandidate })) === true
}

export class PermissionDeniedError extends Error {
  constructor(readonly permissionId: string) {
    super(`Permission denied: ${permissionId}`)
    this.name = 'PermissionDeniedError'
  }
}

export async function assertPermission<TContext>(
  principalCandidate: unknown,
  permission: Permission<TContext>,
  ctx: TContext,
): Promise<void> {
  if (!(await evaluate(principalCandidate, permission, ctx))) {
    throw new PermissionDeniedError(permission.id)
  }
}
