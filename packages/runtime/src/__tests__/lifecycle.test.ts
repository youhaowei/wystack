import { describe, test, expect } from 'bun:test'
import { createLifecycle } from '../lifecycle'

describe('createLifecycle', () => {
  test('runs onStart hooks in order', async () => {
    const order: number[] = []
    const lifecycle = createLifecycle()

    lifecycle.onStart(() => {
      order.push(1)
    })
    lifecycle.onStart(() => {
      order.push(2)
    })
    lifecycle.onStart(() => {
      order.push(3)
    })

    await lifecycle.start()
    expect(order).toEqual([1, 2, 3])
  })

  test('runs onStop hooks in reverse order', async () => {
    const order: number[] = []
    const lifecycle = createLifecycle()

    lifecycle.onStop(() => {
      order.push(1)
    })
    lifecycle.onStop(() => {
      order.push(2)
    })
    lifecycle.onStop(() => {
      order.push(3)
    })

    await lifecycle.stop()
    expect(order).toEqual([3, 2, 1])
  })

  test('handles async hooks', async () => {
    const order: string[] = []
    const lifecycle = createLifecycle()

    lifecycle.onStart(async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push('async-start')
    })
    lifecycle.onStart(() => {
      order.push('sync-start')
    })

    await lifecycle.start()
    expect(order).toEqual(['async-start', 'sync-start'])
  })

  test('stop is idempotent', async () => {
    let count = 0
    const lifecycle = createLifecycle()

    lifecycle.onStop(() => {
      count++
    })

    await lifecycle.stop()
    await lifecycle.stop()
    expect(count).toBe(1)
  })

  test('start is idempotent', async () => {
    let count = 0
    const lifecycle = createLifecycle()

    lifecycle.onStart(() => {
      count++
    })

    await lifecycle.start()
    await lifecycle.start()
    expect(count).toBe(1)
  })

  test('reports state', async () => {
    const lifecycle = createLifecycle()

    expect(lifecycle.state).toBe('idle')

    await lifecycle.start()
    expect(lifecycle.state).toBe('running')

    await lifecycle.stop()
    expect(lifecycle.state).toBe('stopped')
  })

  test('start is idempotent when a hook throws — second call is a no-op', async () => {
    let count = 0
    const lifecycle = createLifecycle()

    lifecycle.onStart(() => {
      count++
      throw new Error('start hook failed')
    })

    await expect(lifecycle.start()).rejects.toThrow('start hook failed')
    // State is 'running' after the first call (set before the hook loop),
    // so a second call must be a no-op and must NOT throw.
    await expect(lifecycle.start()).resolves.toBeUndefined()
    expect(count).toBe(1)
  })

  test('stop hook errors do not prevent other hooks from running', async () => {
    const order: number[] = []
    const lifecycle = createLifecycle()

    lifecycle.onStop(() => {
      order.push(1)
    })
    lifecycle.onStop(() => {
      throw new Error('hook 2 failed')
    })
    lifecycle.onStop(() => {
      order.push(3)
    })

    // Should not throw
    const errors = await lifecycle.stop()
    // Hooks 3 and 1 should still run (reverse order: 3, then error, then 1)
    expect(order).toEqual([3, 1])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
  })
})
