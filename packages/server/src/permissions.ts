import type { Permission } from '@wystack/permissions'

function isPermission(value: unknown): value is Permission<unknown> {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as { id?: unknown; description?: unknown; check?: unknown }
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.check === 'function'
  )
}

function collectPermissionIds(value: unknown, ids: string[]): void {
  if (isPermission(value)) {
    ids.push(value.id)
    return
  }
  if (typeof value !== 'object' || value === null) return
  for (const child of Object.values(value)) collectPermissionIds(child, ids)
}

export function assertPermissionIds(permissions: unknown, expectedIds: readonly string[]): void {
  const actual = [] as string[]
  collectPermissionIds(permissions, actual)
  actual.sort()
  const expected = [...expectedIds].sort()

  if (
    actual.length !== expected.length ||
    actual.some((permissionId, index) => permissionId !== expected[index])
  ) {
    throw new Error(
      `Permission ids differ from snapshot. Expected [${expected.join(', ')}], received [${actual.join(', ')}]`,
    )
  }
}
