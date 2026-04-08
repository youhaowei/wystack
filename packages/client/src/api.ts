/**
 * Api builder — creates a Proxy that returns phantom-branded refs for each key.
 *
 * React-agnostic. The api object is portable across platforms.
 */
import type { FunctionDef } from '@wystack/server'
import type { ApiFromFunctions } from './refs'

/**
 * createApi — builds a runtime Proxy where each property access returns
 * `{ _path: "propertyName" }`. TypeScript sees `ApiFromFunctions<T>`.
 */
export function createApi<T extends Record<string, FunctionDef>>(): ApiFromFunctions<T> {
  return new Proxy({} as ApiFromFunctions<T>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      return { _path: prop }
    },
  })
}
