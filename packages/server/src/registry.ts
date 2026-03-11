import type { QueryDef, MutationDef } from './types'

type FunctionDef = QueryDef | MutationDef

/**
 * Function registry. Collects all queries and mutations,
 * assigns paths, and enables lookup for transport layers.
 */
export function createRegistry() {
  const functions = new Map<string, FunctionDef>()

  return {
    register(path: string, def: FunctionDef) {
      def.path = path
      functions.set(path, def)
    },

    get(path: string) {
      return functions.get(path)
    },

    list() {
      return Array.from(functions.entries())
    },
  }
}
