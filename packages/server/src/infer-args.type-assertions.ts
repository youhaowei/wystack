/**
 * Compile-time regression for `InferArgs` optional-key inference (see `types.ts`).
 *
 * The contract WS-consumers rely on: a `.optional()` column becomes an OMITTABLE
 * key (`key?`), a required column stays a required key, and an optional key still
 * constrains its value type. DashFrame calls typed procedures directly against
 * this shape — if it silently regressed to "every key required", callers would
 * need an arg-erasing escape hatch again.
 *
 * The server tsconfig excludes `*.test.ts` from `tsc --noEmit`, so a runtime test
 * cannot guard a purely-static contract. This file is deliberately NOT named
 * `*.test.ts` (nor `*-test.ts`) so it stays inside the `src` program compiled by
 * both `build` and `typecheck`. The assertions are type-level only, so they erase
 * completely on emit — no runtime artifact ships in `dist`.
 */
import type { ColumnDef } from '@wystack/db'
import type { InferArgs } from './types'

/** Fails to typecheck unless `T` is exactly `true`. */
type Expect<T extends true> = T

// One required column (`id`) and one optional column (`note`).
type Schema = { id: ColumnDef<number, false>; note: ColumnDef<string, true> }
type Args = InferArgs<Schema>

// The optional key may be omitted entirely…
type _OptionalKeyOmittable = Expect<{ id: number } extends Args ? true : false>
// …and it still ships the widened `string | undefined` value type.
type _OptionalValueWidened = Expect<{ id: number; note: undefined } extends Args ? true : false>
// …but its value type is still enforced (a number is not a string).
type _OptionalValueTyped = Expect<{ id: number; note: number } extends Args ? false : true>

// The required key may NOT be omitted.
type _RequiredKeyEnforced = Expect<{ note: 'x' } extends Args ? false : true>

// A schema whose every column is optional is satisfied by `{}`.
type AllOptional = InferArgs<{ a: ColumnDef<string, true>; b: ColumnDef<number, true> }>
type _AllOptionalEmpty = Expect<{} extends AllOptional ? true : false>

// Reference the assertions so they are not flagged as unused if that lint is enabled.
export type __InferArgsOptionalityContract = [
  _OptionalKeyOmittable,
  _OptionalValueWidened,
  _OptionalValueTyped,
  _RequiredKeyEnforced,
  _AllOptionalEmpty,
]
