import { describe, test, expect } from 'bun:test'
import { query, mutation } from '../functions'
import { text, int } from '@wystack/db'

describe('query()', () => {
  test('creates a QueryDef with correct type', () => {
    const q = query({
      args: { type: text.optional() },
      handler: async (ctx, args) => {
        return []
      },
    })
    expect(q.type).toBe('query')
    expect(q.path).toBe('')
    expect(q.args.type).toBeDefined()
  })

  test('handler receives context and args', async () => {
    const q = query({
      args: { id: int },
      handler: async (ctx, args) => {
        return { received: args.id }
      },
    })
    const result = await q.handler({ db: {} as any }, { id: 42 })
    expect(result).toEqual({ received: 42 })
  })
})

describe('mutation()', () => {
  test('creates a MutationDef with correct type', () => {
    const m = mutation({
      args: { title: text },
      handler: async (ctx, args) => {
        return { created: true }
      },
    })
    expect(m.type).toBe('mutation')
  })
})
