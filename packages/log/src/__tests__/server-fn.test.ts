import { describe, test, expect, mock, beforeEach, afterAll } from 'bun:test'
import type { WideEvent } from '../wide-event'
import { withLogging, __setWideEventFactory, __resetWideEventFactory } from '../server-fn'

// Instances are tracked here so tests can inspect them
const createdInstances: MockWideEventInstance[] = []

interface MockWideEventInstance {
  _name: string
  set: ReturnType<typeof mock>
  flush: ReturnType<typeof mock>
}

class MockWideEvent {
  _name: string
  set: ReturnType<typeof mock>
  flush: ReturnType<typeof mock>

  constructor(name: string) {
    this._name = name
    this.set = mock(() => this)
    this.flush = mock(() => {})
    createdInstances.push(this)
  }
}

__setWideEventFactory((name) => new MockWideEvent(name) as unknown as WideEvent)

afterAll(() => {
  __resetWideEventFactory()
})

function lastInstance(): MockWideEventInstance {
  return createdInstances[createdInstances.length - 1]
}

describe('withLogging', () => {
  beforeEach(() => {
    createdInstances.length = 0
  })

  test('returns a function', () => {
    const wrapped = withLogging({ name: 'test' }, async (_ctx, _ev) => 'result')
    expect(typeof wrapped).toBe('function')
  })

  test('returns the handler result on success', async () => {
    const wrapped = withLogging({ name: 'doThing' }, async (_ctx, _ev) => 42)
    const result = await wrapped({ data: null })
    expect(result).toBe(42)
  })

  test('creates WideEvent named server.<fn_name>', async () => {
    const wrapped = withLogging({ name: 'myFn' }, async () => null)
    await wrapped({ data: null })
    expect(lastInstance()._name).toBe('server.myFn')
  })

  test('sets fn_name on the event', async () => {
    const wrapped = withLogging({ name: 'doThing' }, async () => null)
    await wrapped({ data: null })
    const inst = lastInstance()
    const setCalls = inst.set.mock.calls
    const firstCallFields = setCalls[0][0] as Record<string, unknown>
    expect(firstCallFields.fn_name).toBe('doThing')
  })

  test('sets fn_method on the event', async () => {
    const wrapped = withLogging({ name: 'doThing', method: 'POST' }, async () => null)
    await wrapped({ data: null })
    const setCalls = lastInstance().set.mock.calls
    const firstCallFields = setCalls[0][0] as Record<string, unknown>
    expect(firstCallFields.fn_method).toBe('POST')
  })

  test('sets result_count for array results', async () => {
    const wrapped = withLogging({ name: 'list' }, async () => ['a', 'b', 'c'])
    await wrapped({ data: null })
    const allFields = lastInstance().set.mock.calls.map((c) => c[0] as Record<string, unknown>)
    expect(allFields.some((f) => f.result_count === 3)).toBe(true)
  })

  test('does not set result_count for non-array results', async () => {
    const wrapped = withLogging({ name: 'get' }, async () => ({ id: 1 }))
    await wrapped({ data: null })
    const allFields = lastInstance().set.mock.calls.map((c) => c[0] as Record<string, unknown>)
    expect(allFields.some((f) => 'result_count' in f)).toBe(false)
  })

  test('sets outcome success on successful handler', async () => {
    const wrapped = withLogging({ name: 'ok' }, async () => null)
    await wrapped({ data: null })
    const allFields = lastInstance().set.mock.calls.map((c) => c[0] as Record<string, unknown>)
    expect(allFields.some((f) => f.outcome === 'success')).toBe(true)
  })

  test('calls event.flush() on success', async () => {
    const wrapped = withLogging({ name: 'ok' }, async () => null)
    await wrapped({ data: null })
    expect(lastInstance().flush.mock.calls.length).toBe(1)
  })

  test('rethrows error from handler', async () => {
    const boom = new Error('boom')
    const wrapped = withLogging({ name: 'fail' }, async () => {
      throw boom
    })
    await expect(wrapped({ data: null })).rejects.toThrow('boom')
  })

  test('sets outcome error on handler throw', async () => {
    const wrapped = withLogging({ name: 'fail' }, async () => {
      throw new Error('oops')
    })
    try {
      await wrapped({ data: null })
    } catch {}
    const allFields = lastInstance().set.mock.calls.map((c) => c[0] as Record<string, unknown>)
    expect(allFields.some((f) => f.outcome === 'error')).toBe(true)
  })

  test('sets error_type and error_message on handler throw', async () => {
    const wrapped = withLogging({ name: 'fail' }, async () => {
      throw new Error('something broke')
    })
    try {
      await wrapped({ data: null })
    } catch {}
    const allFields = lastInstance().set.mock.calls.map((c) => c[0] as Record<string, unknown>)
    const errorFields = allFields.find((f) => f.outcome === 'error')
    expect(errorFields?.error_message).toBe('something broke')
    expect(errorFields?.error_type).toBe('Error')
  })

  test('calls event.flush() on handler throw', async () => {
    const wrapped = withLogging({ name: 'fail' }, async () => {
      throw new Error('oops')
    })
    try {
      await wrapped({ data: null })
    } catch {}
    expect(lastInstance().flush.mock.calls.length).toBe(1)
  })

  test('opts.context() extracts custom fields into event', async () => {
    const wrapped = withLogging(
      {
        name: 'ctx',
        context: (data: { orgId: string }) => ({ org_id: data.orgId }),
      },
      async () => null,
    )
    await wrapped({ data: { orgId: 'org-123' } })
    const allFields = lastInstance().set.mock.calls.map((c) => c[0] as Record<string, unknown>)
    expect(allFields.some((f) => f.org_id === 'org-123')).toBe(true)
  })

  test('opts.context() exception is caught and flush still runs', async () => {
    const wrapped = withLogging(
      {
        name: 'ctx-throws',
        context: () => {
          throw new Error('context error')
        },
      },
      async () => 'ok',
    )
    try {
      await wrapped({ data: null })
    } catch {}
    // flush must still be called even if context() throws
    expect(lastInstance().flush.mock.calls.length).toBe(1)
  })
})
