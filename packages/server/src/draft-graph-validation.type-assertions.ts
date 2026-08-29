/**
 * Compile-time contract for the graph validator's database capability.
 * Validators may inspect rows but cannot regain a mutation or raw SQL surface.
 */
import type { DraftGraphValidationRequest } from './draft-lifecycle-types'

type Expect<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type ValidationDb = DraftGraphValidationRequest['db']
type ForbiddenTrackerKeys =
  | 'into'
  | 'raw'
  | 'transaction'
  | 'withDraft'
  | 'withTenant'
  | 'tablesWritten'
type ValidationBuilder = ReturnType<ValidationDb['from']>
type ForbiddenBuilderKeys = 'insert' | 'update' | 'delete'

type _TrackerHasNoWriteEscape = Expect<
  Equal<Extract<keyof ValidationDb, ForbiddenTrackerKeys>, never>
>
type _BuilderHasNoWriteMethods = Expect<
  Equal<Extract<keyof ValidationBuilder, ForbiddenBuilderKeys>, never>
>

export type __DraftGraphValidationReadContract = [
  _TrackerHasNoWriteEscape,
  _BuilderHasNoWriteMethods,
]
