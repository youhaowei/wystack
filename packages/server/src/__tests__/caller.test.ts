import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { text, int } from '@wystack/db'
import { defineApp } from '../define-app'
import { createCaller } from '../caller'
import type { CallerFromFunctions } from '../caller'

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const functions = {
  greet: wy.procedure.input({ name: text }).query(async (_ctx, args) => `hello ${args.name}`),
  double: wy.procedure.input({ n: int }).mutation(async (_ctx, args) => args.n * 2),
}

type Functions = typeof functions

let app: Awaited<ReturnType<typeof wy.build>>

beforeEach(async () => {
  const pg = new PGlite()
  const db = drizzle(pg)
  app = await wy.build({ db, functions })
})

describe('createCaller', () => {
  test('dispatches queries and mutations with typed results', async () => {
    const caller = createCaller<Functions>(app, {})

    await expect(caller.greet({ name: 'wy' })).resolves.toBe('hello wy')
    await expect(caller.double({ n: 21 })).resolves.toBe(42)
  })

  test('forwards request context through app.call', async () => {
    const withCtx = {
      whoami: wy.procedure.input({}).query(async (ctx) => {
        const principal = (ctx as { principal?: { userId?: string } }).principal
        return principal?.userId ?? null
      }),
    }
    const pg = new PGlite()
    const db = drizzle(pg)
    const ctxApp = await wy.build({ db, functions: withCtx })
    const caller = createCaller<typeof withCtx>(ctxApp, {
      principal: { kind: 'user', userId: 'user-1' },
    })

    await expect(caller.whoami({})).resolves.toBe('user-1')
  })
})

// ---------------------------------------------------------------------------
// Type-level pin — wrong arg types must fail to compile
// ---------------------------------------------------------------------------

function assertCallerTypes(caller: CallerFromFunctions<Functions>) {
  void caller.greet({ name: 'ok' })
  void caller.double({ n: 1 })

  // @ts-expect-error — name must be a string, not a number
  void caller.greet({ name: 123 })
  // @ts-expect-error — n must be a number, not a string
  void caller.double({ n: 'nope' })
}

void assertCallerTypes
