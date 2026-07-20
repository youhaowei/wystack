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

/**
 * Narrows an untrusted context value to a Principal.
 *
 * `context.principal` is populated by an application-supplied resolver, so at
 * this boundary it is genuinely unknown — a cast would let `{ kind: 'user' }`
 * with no `userId` reach the application's `checkPermission`, which may grant
 * by kind alone. The identifier each kind carries is what makes it a principal,
 * so both the discriminant and its payload are validated here.
 */
function isPrincipal(value: unknown): value is Principal {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { kind?: unknown; userId?: unknown; credentialId?: unknown }
  if (candidate.kind === 'user') {
    return typeof candidate.userId === 'string' && candidate.userId.length > 0
  }
  if (candidate.kind === 'service') {
    return typeof candidate.credentialId === 'string' && candidate.credentialId.length > 0
  }
  return false
}

export async function assertFunctionPermission(
  fn: FunctionDef,
  context: Record<string, unknown>,
  checkPermission: CheckPermission | undefined,
): Promise<void> {
  if (!fn.permission) return

  // Fail closed on every path: an absent or malformed principal, an unwired
  // checkPermission, and a falsy check all deny. A checkPermission that throws
  // also denies — the rejection propagates and the call never dispatches.
  const principal = context.principal
  if (
    !isPrincipal(principal) ||
    !checkPermission ||
    !(await checkPermission(principal, fn.permission))
  ) {
    throw new PermissionDeniedError(fn.permission)
  }
}
