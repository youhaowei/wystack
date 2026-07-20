import type { FunctionDef } from './types'

export type CheckPermission = (
  userId: string,
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

  const userId = context.userId
  if (
    typeof userId !== 'string' ||
    !checkPermission ||
    !(await checkPermission(userId, fn.permission))
  ) {
    throw new PermissionDeniedError(fn.permission)
  }
}
