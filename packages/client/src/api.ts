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
 *
 * Refs are cached per key, so `api.foo === api.foo` (referentially stable).
 * Non-string and Promise-related properties (`then`, `catch`, etc.) return
 * `undefined` so the api object isn't accidentally awaitable.
 */
export function createApi<T extends Record<string, FunctionDef>>(): ApiFromFunctions<T> {
  const cache = new Map<string, { _path: string }>()
  return new Proxy({} as ApiFromFunctions<T>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      // Avoid making the proxy thenable / promise-shaped
      if (prop === 'then' || prop === 'catch' || prop === 'finally') return undefined
      let ref = cache.get(prop)
      if (!ref) {
        ref = { _path: prop }
        cache.set(prop, ref)
      }
      return ref
    },
  })
}
