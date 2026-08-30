/**
 * Compile-time regressions for the explicit legacy procedure bridge.
 *
 * Native handlers must not regain raw database or tracking custody. The legacy
 * builder adds only those migration capabilities; tenant/draft scope changes
 * remain absent from both public handler contexts.
 */
import { defineApp } from './define-app'
import type { ProcedureBuilder } from './functions'
import type {
  FunctionContext,
  LegacyFunctionContext,
  LegacyProcedureDb,
  ProcedureDb,
} from './types'

type Expect<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
type BuilderContext<T> =
  T extends ProcedureBuilder<infer TContext, infer _TArgs, infer _TDatabaseAccess>
    ? TContext
    : never

type AppContext = { orgId: string }
type Definition = ReturnType<typeof defineApp<AppContext>>
type NativeContext = BuilderContext<Definition['procedure']>
type LegacyContext = BuilderContext<Definition['legacyProcedure']>
type LegacyCapabilities = 'raw' | 'tablesRead' | 'tablesWritten'
type ScopeCapabilities = 'withTenant' | 'withDraft'

type _NativeBuilderUsesNativeContext = Expect<Equal<NativeContext, FunctionContext<AppContext>>>
type _LegacyBuilderUsesLegacyContext = Expect<
  Equal<LegacyContext, LegacyFunctionContext<AppContext>>
>
type _NativeDbOmitsLegacyCapabilities = Expect<
  Equal<Extract<keyof ProcedureDb, LegacyCapabilities>, never>
>
type _LegacyDbExposesCompatibilityCapabilities = Expect<
  Equal<Extract<keyof LegacyProcedureDb, LegacyCapabilities>, LegacyCapabilities>
>
type _LegacyDbOmitsScopeCapabilities = Expect<
  Equal<Extract<keyof LegacyProcedureDb, ScopeCapabilities>, never>
>
type _LegacyContextRemainsUsableAsNative = Expect<
  LegacyFunctionContext<AppContext> extends FunctionContext<AppContext> ? true : false
>
type _LegacyBuilderCannotDeclareCommands = Expect<
  Equal<Definition['legacyProcedure']['command'], never>
>

export type __LegacyProcedureContract = [
  _NativeBuilderUsesNativeContext,
  _LegacyBuilderUsesLegacyContext,
  _NativeDbOmitsLegacyCapabilities,
  _LegacyDbExposesCompatibilityCapabilities,
  _LegacyDbOmitsScopeCapabilities,
  _LegacyContextRemainsUsableAsNative,
  _LegacyBuilderCannotDeclareCommands,
]
