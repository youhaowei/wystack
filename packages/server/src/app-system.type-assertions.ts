/**
 * Compile-time regression for the privileged application capability.
 *
 * Procedures and ordinary app consumers use the root `WyStackApp` surface.
 * Tracker construction, scoped dispatch, and explicit invalidation remain
 * available only through the deliberately named `app.system` capability.
 */
import type { DrizzleTracker } from '@wystack/db'
import type { WyStackApp } from './create'

/** Fails to typecheck unless `T` is exactly `true`. */
type Expect<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type PrivilegedKeys = 'createTracked' | 'emit' | 'runHandler' | 'scopeTracked'

type _RootOmitsPrivilegedSeams = Expect<Equal<Extract<keyof WyStackApp, PrivilegedKeys>, never>>
type _SystemExposesExactlyPrivilegedSeams = Expect<
  Equal<keyof WyStackApp['system'], PrivilegedKeys>
>
type _SystemMintsFullTracker = Expect<
  Equal<ReturnType<WyStackApp['system']['createTracked']>, DrizzleTracker>
>

export type __WyStackSystemCapabilityContract = [
  _RootOmitsPrivilegedSeams,
  _SystemExposesExactlyPrivilegedSeams,
  _SystemMintsFullTracker,
]
