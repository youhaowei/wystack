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

function collectPermissionIds(value: unknown, ids: Set<string>, visited: Set<object>): void {
  if (typeof value !== 'object' || value === null || visited.has(value)) return
  visited.add(value)

  if (isPermission(value)) {
    ids.add(value.id)
    return
  }
  for (const child of Object.values(value)) collectPermissionIds(child, ids, visited)
}

export function assertPermissionIds(permissions: unknown, expectedIds: readonly string[]): void {
  const ids = new Set<string>()
  collectPermissionIds(permissions, ids, new Set())
  const actual = [...ids].sort()
  const expected = [...new Set(expectedIds)].sort()

  if (
    actual.length !== expected.length ||
    actual.some((permissionId, index) => permissionId !== expected[index])
  ) {
    throw new Error(
      `Permission ids differ from snapshot. Expected [${expected.join(', ')}], received [${actual.join(', ')}]`,
    )
  }
}
