/** Compile-time contracts for the explicit raw application boundaries. */
import { defineApp } from './define-app'
import type { ProcedureBuilder } from './functions'
import type { IntegrationFunctionContext, RawProcedureDb, ReadModelFunctionContext } from './types'

type Expect<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false
type IsNotAny<T> = IsAny<T> extends true ? false : true
type Equal<A, B> =
  IsAny<A> extends true
    ? false
    : IsAny<B> extends true
      ? false
      : [A] extends [B]
        ? [B] extends [A]
          ? true
          : false
        : false
type BuilderContext<T> =
  T extends ProcedureBuilder<infer TContext, infer _TArgs, infer _TDatabaseAccess>
    ? TContext
    : never

type AppContext = { orgId: string }
type Definition = ReturnType<typeof defineApp<AppContext>>
type ReadModelContext = BuilderContext<Definition['readModel']>
type IntegrationContext = BuilderContext<Definition['integration']>
type ReadModelDefinition = ReturnType<Definition['readModel']['query']>
type IntegrationDefinition = ReturnType<Definition['integration']['mutation']>
type RawCapabilities = 'raw' | 'tablesRead' | 'tablesWritten'
type ScopeCapabilities = 'withTenant' | 'withDraft'

type _ReadModelContextIsNotAny = Expect<IsNotAny<ReadModelContext>>
type _IntegrationContextIsNotAny = Expect<IsNotAny<IntegrationContext>>
type _RawProcedureDbIsNotAny = Expect<IsNotAny<RawProcedureDb>>
type _ReadModelUsesRawContext = Expect<
  Equal<ReadModelContext, ReadModelFunctionContext<AppContext>>
>
type _IntegrationUsesRawContext = Expect<
  Equal<IntegrationContext, IntegrationFunctionContext<AppContext>>
>
type _RawDbExposesExplicitCapabilities = Expect<
  Equal<Extract<keyof RawProcedureDb, RawCapabilities>, RawCapabilities>
>
type _RawDbOmitsScopeCapabilities = Expect<
  Equal<Extract<keyof RawProcedureDb, ScopeCapabilities>, never>
>
type _ReadModelMarkerIsDistinct = Expect<
  Equal<ReadModelDefinition['databaseAccess'], 'read-model-raw'>
>
type _IntegrationMarkerIsDistinct = Expect<
  Equal<IntegrationDefinition['databaseAccess'], 'integration-raw'>
>
type _IntegrationIsCanonicalOnly = Expect<Equal<IntegrationDefinition['draftReplayable'], false>>
type _ReadModelCannotDeclareMutations = Expect<Equal<Definition['readModel']['mutation'], never>>
type _ReadModelCannotDeclareActions = Expect<Equal<Definition['readModel']['action'], never>>
type _ReadModelCannotDeclareCommands = Expect<Equal<Definition['readModel']['command'], never>>
type _IntegrationCannotQuery = Expect<Equal<Definition['integration']['query'], never>>
type _IntegrationCannotDeclareActions = Expect<Equal<Definition['integration']['action'], never>>
type _IntegrationCannotDeclareCommands = Expect<Equal<Definition['integration']['command'], never>>

export type __RawProcedureContract = [
  _ReadModelContextIsNotAny,
  _IntegrationContextIsNotAny,
  _RawProcedureDbIsNotAny,
  _ReadModelUsesRawContext,
  _IntegrationUsesRawContext,
  _RawDbExposesExplicitCapabilities,
  _RawDbOmitsScopeCapabilities,
  _ReadModelMarkerIsDistinct,
  _IntegrationMarkerIsDistinct,
  _IntegrationIsCanonicalOnly,
  _ReadModelCannotDeclareMutations,
  _ReadModelCannotDeclareActions,
  _ReadModelCannotDeclareCommands,
  _IntegrationCannotQuery,
  _IntegrationCannotDeclareActions,
  _IntegrationCannotDeclareCommands,
]
