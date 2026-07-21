import { describe, expect, test } from 'bun:test'
import {
  allOf,
  anyOf,
  assertPermission,
  definePermissions,
  evaluate,
  PermissionDeniedError,
  type Permission,
} from '../index'

interface TestContext {
  readonly accountId: string
}

const principal = { kind: 'user', userId: 'user-1' } as const
const context: TestContext = { accountId: 'account-1' }

function permission(id: string, check: Permission<TestContext>['check']): Permission<TestContext> {
  return { id, description: `Can ${id}`, check }
}

describe('evaluate', () => {
  test('denies an absent principal', async () => {
    await expect(
      evaluate(
        undefined,
        permission('read', async () => true),
        context,
      ),
    ).resolves.toBe(false)
  })

  test('denies a malformed principal', async () => {
    await expect(
      evaluate(
        { kind: 'user' },
        permission('read', async () => true),
        context,
      ),
    ).resolves.toBe(false)
  })

  test('denies when the check returns false', async () => {
    await expect(
      evaluate(
        principal,
        permission('read', () => false),
        context,
      ),
    ).resolves.toBe(false)
  })

  test.each([1, 'yes'])('denies a truthy non-boolean result: %p', async (result) => {
    await expect(
      evaluate(
        principal,
        permission('read', () => result as never),
        context,
      ),
    ).resolves.toBe(false)
  })

  test('grants only when the check returns true', async () => {
    await expect(
      evaluate(
        principal,
        permission('read', async () => true),
        context,
      ),
    ).resolves.toBe(true)
  })

  test('passes the validated principal into the check context', async () => {
    const seesPrincipal = permission('read', (ctx) =>
      'principal' in ctx ? ctx.principal === principal : false,
    )

    await expect(evaluate(principal, seesPrincipal, context)).resolves.toBe(true)
  })

  test('propagates a throwing check', async () => {
    const failure = new Error('check failed')

    await expect(
      evaluate(
        principal,
        permission('read', () => {
          throw failure
        }),
        context,
      ),
    ).rejects.toBe(failure)
  })

  test('propagates a rejected async check', async () => {
    const failure = new Error('async check failed')

    await expect(
      evaluate(
        principal,
        permission('read', async () => {
          throw failure
        }),
        context,
      ),
    ).rejects.toBe(failure)
  })
})

describe('assertPermission', () => {
  test('throws PermissionDeniedError with the denied permission id', async () => {
    const denied = permission('accessCredentials.manage', () => false)

    try {
      await assertPermission(principal, denied, context)
      throw new Error('expected assertPermission to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedError)
      expect((error as PermissionDeniedError).permissionId).toBe('accessCredentials.manage')
    }
  })

  test('resolves on grant', async () => {
    await expect(
      assertPermission(
        principal,
        permission('read', () => true),
        context,
      ),
    ).resolves.toBeUndefined()
  })
})

describe('permission combinators', () => {
  test('allOf and anyOf deny truthy non-boolean child results', async () => {
    const truthy = permission('truthy', () => 1 as never)
    const denied = permission('denied', () => false)

    await expect(allOf(truthy).check(context)).resolves.toBe(false)
    await expect(anyOf(truthy, denied).check(context)).resolves.toBe(false)
  })

  test.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])('allOf(%p, %p) returns %p', async (left, right, expected) => {
    const combined = allOf(
      permission('left', () => left),
      permission('right', async () => right),
    )

    await expect(combined.check(context)).resolves.toBe(expected)
    expect(combined.id).toBe('allOf(left, right)')
    expect(combined.description).toBe('All of: Can left; Can right')
  })

  test.each([
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ])('anyOf(%p, %p) returns %p', async (left, right, expected) => {
    const combined = anyOf(
      permission('left', async () => left),
      permission('right', () => right),
    )

    await expect(combined.check(context)).resolves.toBe(expected)
    expect(combined.id).toBe('anyOf(left, right)')
    expect(combined.description).toBe('Any of: Can left; Can right')
  })
})

describe('definePermissions', () => {
  test('derives dotted ids while preserving nested traversal', async () => {
    const permissions = definePermissions<TestContext>()({
      accessCredentials: {
        manage: {
          description: 'Manage access credentials',
          check: (ctx) => ctx.accountId === 'account-1',
        },
      },
      reports: {
        view: {
          description: 'View reports',
          check: async () => true,
        },
      },
    })

    expect(permissions.accessCredentials.manage.id).toBe('accessCredentials.manage')
    expect(permissions.reports.view.id).toBe('reports.view')
    expect(await permissions.accessCredentials.manage.check(context)).toBe(true)
  })
})
