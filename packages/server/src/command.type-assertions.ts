/** Compile-time contracts for the explicit replay-safe command terminal. */
import { defineApp } from './define-app'

type Expect<T extends true> = T
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

type Definition = ReturnType<typeof defineApp<Record<string, unknown>>>
type CommandHandler = Parameters<Definition['procedure']['command']>[0]
type CommandHandlerContext = Parameters<CommandHandler>[0]
type MutationHandler = Parameters<Definition['procedure']['mutation']>[0]
type MutationHandlerContext = Parameters<MutationHandler>[0]

type _CommandHandlerOmitsTransactions = Expect<
  Equal<Extract<keyof CommandHandlerContext['db'], 'transaction'>, never>
>
type _MutationHandlerRetainsTransactions = Expect<
  Equal<Extract<keyof MutationHandlerContext['db'], 'transaction'>, 'transaction'>
>

const commandApp = defineApp<Record<string, unknown>>({ permissions: {} })
commandApp.procedure.use(({ next }) => {
  // @ts-expect-error — middleware cannot replace the framework-owned database facade
  return next({ db: {} })
})
commandApp.procedure.use(({ ctx, next }) => {
  // @ts-expect-error — middleware receives an immutable framework context
  ctx.db = {}
  return next()
})

export type __CommandProcedureContract = [
  _CommandHandlerOmitsTransactions,
  _MutationHandlerRetainsTransactions,
]
