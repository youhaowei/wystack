import type { Permission } from './permission'

interface PermissionDefinition<TContext> {
  readonly description: string
  readonly check: (ctx: TContext) => boolean | Promise<boolean>
}

interface PermissionTree<TContext> {
  readonly [key: string]: PermissionDefinition<TContext> | PermissionTree<TContext>
}

type DefinedPermissions<TContext, TTree extends PermissionTree<TContext>> = {
  readonly [TKey in keyof TTree]: TTree[TKey] extends PermissionDefinition<TContext>
    ? Permission<TContext>
    : TTree[TKey] extends PermissionTree<TContext>
      ? DefinedPermissions<TContext, TTree[TKey]>
      : never
}

function isPermissionDefinition<TContext>(
  value: PermissionDefinition<TContext> | PermissionTree<TContext>,
): value is PermissionDefinition<TContext> {
  return (
    'description' in value &&
    typeof value.description === 'string' &&
    'check' in value &&
    typeof value.check === 'function'
  )
}

function defineTree<TContext>(
  tree: PermissionTree<TContext>,
  parentPath: readonly string[],
): Record<string, unknown> {
  const defined: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(tree)) {
    const path = [...parentPath, key]
    defined[key] = isPermissionDefinition(value)
      ? {
          id: path.join('.'),
          description: value.description,
          check: value.check,
        }
      : defineTree(value, path)
  }

  return defined
}

export function definePermissions<TContext>() {
  return <const TTree extends PermissionTree<TContext>>(
    tree: TTree,
  ): DefinedPermissions<TContext, TTree> =>
    defineTree(tree, []) as DefinedPermissions<TContext, TTree>
}
