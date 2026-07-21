import { describe, test, expect } from 'bun:test'
import { text, int } from '@wystack/db'
import { defineApp } from '../define-app'
import type { FunctionContext, MiddlewareFn } from '../types'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

describe('procedure builder', () => {
  test('creates a QueryDef with correct type', () => {
    const q = wy.procedure.input({ type: text.optional() }).query(async (_ctx, _args) => [])
    expect(q.type).toBe('query')
    expect(q.path).toBe('')
    expect(q.args.type).toBeDefined()
  })

  test('handler receives context and args', async () => {
    const q = wy.procedure.input({ id: int }).query(async (_ctx, args) => ({ received: args.id }))
    // oxlint-disable-next-line typescript/no-explicit-any -- mock context; full db type not needed in unit test
    const result = await q.handler({ db: {} as any }, { id: 42 })
    expect(result).toEqual({ received: 42 })
  })

  test('creates a MutationDef with correct type', () => {
    const m = wy.procedure
      .input({ title: text })
      .mutation(async (_ctx, _args) => ({ created: true }))
    expect(m.type).toBe('mutation')
  })

  test('composes minimal middleware patches with Overwrite', async () => {
    const definition = wy.procedure
      .use(({ next }) => next({ count: 1 }))
      .use(({ ctx, next }) => next({ label: `count:${ctx.count}` }))
      .input({ id: int })
      .query(async (ctx, args) => ({ count: ctx.count, label: ctx.label, id: args.id }))

    const result = await definition.handler({}, { id: 7 })
    expect(result).toEqual({ count: 1, label: 'count:1', id: 7 })
  })

  test('branching from one builder keeps middleware immutable', async () => {
    const base = wy.procedure.use(({ next }) => next({ base: true }))
    const left = base
      .use(({ next }) => next({ side: 'left' }))
      .input({})
      .query(async (ctx) => ctx.side)
    const right = base
      .use(({ next }) => next({ side: 'right' }))
      .input({})
      .query(async (ctx) => ctx.side)

    await expect(left.handler({}, {})).resolves.toBe('left')
    await expect(right.handler({}, {})).resolves.toBe('right')
  })

  test('a stage that does not return next() cannot grant', async () => {
    const forgotNext = (() => ({})) as unknown as MiddlewareFn<
      FunctionContext<Record<string, unknown>>,
      { granted: true }
    >
    const definition = wy.procedure
      .use(forgotNext)
      .input({})
      .query(async (ctx) => ctx.granted)

    await expect(definition.handler({}, {})).rejects.toThrow(
      'Middleware must return the value produced by next()',
    )
  })

  test('requireAuth narrows a valid principal and throws when absent', async () => {
    const definition = wy.procedure
      .use(wy.requireAuth)
      .input({})
      .query(async (ctx) => ctx.principal.kind)

    await expect(definition.handler({}, {})).rejects.toThrow('Authentication required')
    await expect(
      definition.handler({ principal: { kind: 'user', userId: 'user-1' } }, {}),
    ).resolves.toBe('user')
  })

  test('a throwing middleware error propagates', async () => {
    const definition = wy.procedure
      .use(async () => {
        throw new Error('stage boom')
      })
      .input({})
      .query(async () => true)

    await expect(definition.handler({}, {})).rejects.toThrow('stage boom')
  })
})
