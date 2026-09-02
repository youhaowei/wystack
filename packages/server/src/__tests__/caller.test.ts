import { describe, test, expect, beforeEach } from 'bun:test'
import { createTestPg, useTestPglite } from '@wystack/db/testing'
import { drizzle } from 'drizzle-orm/pglite'
import { text, int } from '@wystack/db'
import { defineApp } from '../define-app'
import { createCaller } from '../caller'
import type { CallerFromFunctions } from '../caller'

useTestPglite()

const wy = defineApp<Record<string, unknown>>({ permissions: {} })

const functions = {
  greet: wy.procedure.input({ name: text }).query(async (_ctx, args) => `hello ${args.name}`),
  double: wy.procedure.input({ n: int }).mutation(async (_ctx, args) => args.n * 2),
  external: wy.procedure.input({ value: text }).action(async (_ctx, args) => args.value.length),
}

type Functions = typeof functions

let app: Awaited<ReturnType<typeof wy.build>>

beforeEach(async () => {
  const pg = createTestPg()
  const db = drizzle(pg)
  app = await wy.build({ db, functions })
})

describe('createCaller', () => {
  test('dispatches queries, mutations, and actions with typed results', async () => {
    const caller = createCaller<Functions>(app, {})

    await expect(caller.greet({ name: 'wy' })).resolves.toBe('hello wy')
    await expect(caller.double({ n: 21 })).resolves.toBe(42)
    await expect(caller.external({ value: 'wy' })).resolves.toBe(2)
  })

  test('forwards request context through app.call', async () => {
    const withCtx = {
      whoami: wy.procedure.input({}).query(async (ctx) => {
        const principal = (ctx as { principal?: { userId?: string } }).principal
        return principal?.userId ?? null
      }),
    }
    const pg = createTestPg()
    const db = drizzle(pg)
    const ctxApp = await wy.build({ db, functions: withCtx })
    const caller = createCaller<typeof withCtx>(ctxApp, {
      principal: { kind: 'user', userId: 'user-1' },
    })

    await expect(caller.whoami({})).resolves.toBe('user-1')
  })

  // Registration accepts any string as a procedure path, including names that
  // are special on a normal object. `createCaller` built its dictionary with
  // `{}`, so `caller['__proto__'] = fn` hit the legacy prototype setter: the
  // property was never created and the object's prototype was replaced instead.
  // A null-prototype dictionary has no such setter.
  //
  // The COMPUTED key matters. A plain `{ __proto__: fn }` literal is itself the
  // prototype setter, so the procedure would never reach the registry and the
  // test would pass vacuously; `{ ['__proto__']: fn }` creates a real own
  // property, which is the only way this reaches `createCaller` at all.
  //
  // Red before the fix — but via the LAST assertion, not the obvious one.
  // `caller['__proto__'] = fn` set the dictionary's prototype to `fn`, and
  // reading `caller['__proto__']` then returns that same prototype, so the
  // lookup and the call both appear to work. The visible damage is the
  // corrupted prototype: every unrelated key now resolves through a function
  // object. That is why the prototype is asserted explicitly — checking only
  // callability would have passed against the bug.
  test('a procedure named __proto__ is callable and does not corrupt the caller', async () => {
    const reserved = {
      ['__proto__']: wy.procedure.input({}).query(async () => 'reserved-name-ok'),
    }
    const pg = createTestPg()
    const db = drizzle(pg)
    const protoApp = await wy.build({ db, functions: reserved })
    const caller = createCaller<typeof reserved>(protoApp, {})

    const bag = caller as unknown as Record<string, (a: object) => Promise<unknown>>
    expect(typeof bag['__proto__']).toBe('function')
    await expect(bag['__proto__']({})).resolves.toBe('reserved-name-ok')
    // The dictionary itself must be uncorrupted — a null-prototype object.
    expect(Object.getPrototypeOf(caller)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Type-level pin — wrong arg types must fail to compile
// ---------------------------------------------------------------------------

function assertCallerTypes(caller: CallerFromFunctions<Functions>) {
  void caller.greet({ name: 'ok' })
  void caller.double({ n: 1 })
  void caller.external({ value: 'ok' })

  // @ts-expect-error — name must be a string, not a number
  void caller.greet({ name: 123 })
  // @ts-expect-error — n must be a number, not a string
  void caller.double({ n: 'nope' })
  // @ts-expect-error — value must be a string
  void caller.external({ value: 1 })
}

void assertCallerTypes
