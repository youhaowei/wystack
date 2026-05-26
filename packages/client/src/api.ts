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
 * Non-string and well-known probe keys (`then`, `toJSON`, `Symbol.iterator`,
 * etc.) return `undefined` so the api object isn't accidentally awaitable,
 * serializable, or stringifiable — those would invoke a returned ref as a
 * function and crash with `TypeError: ref is not a function`.
 */
const PROBE_KEYS = new Set([
  'then',
  'catch',
  'finally',
  'toJSON',
  'toString',
  'valueOf',
  'inspect',
  'nodeType',
  '$$typeof',
])

export function createApi<T extends Record<string, FunctionDef>>(): ApiFromFunctions<T> {
  const cache = new Map<string, { _path: string }>()
  return new Proxy({} as ApiFromFunctions<T>, {
    get(_target, prop) {
      if (typeof prop !== 'string') return undefined
      if (PROBE_KEYS.has(prop)) return undefined
      let ref = cache.get(prop)
      if (!ref) {
        ref = { _path: prop }
        cache.set(prop, ref)
      }
      return ref
    },
  })
}
