import type { Permission } from './permission'

function compositeDescription<TContext>(
  label: string,
  permissions: readonly Permission<TContext>[],
): string {
  return `${label}: ${permissions.map((permission) => permission.description).join('; ')}`
}

export function allOf<TContext>(...permissions: Permission<TContext>[]): Permission<TContext> {
  return {
    id: `allOf(${permissions.map((permission) => permission.id).join(', ')})`,
    description: compositeDescription('All of', permissions),
    async check(ctx) {
      for (const permission of permissions) {
        if ((await permission.check(ctx)) !== true) return false
      }
      return true
    },
  }
}

export function anyOf<TContext>(...permissions: Permission<TContext>[]): Permission<TContext> {
  return {
    id: `anyOf(${permissions.map((permission) => permission.id).join(', ')})`,
    description: compositeDescription('Any of', permissions),
    async check(ctx) {
      for (const permission of permissions) {
        if ((await permission.check(ctx)) === true) return true
      }
      return false
    },
  }
}
