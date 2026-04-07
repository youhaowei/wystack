import { describe, test, expect, mock, beforeEach } from 'bun:test'

// Mock logger before anything imports wide-event
const mockLogger = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
}

mock.module('../logger', () => ({
  logger: mockLogger,
}))

// Import after mock is registered
const { WideEvent } = await import('../wide-event')

describe('WideEvent constructor', () => {
  test('sets event_name from constructor argument', () => {
    const ev = new WideEvent('test.event')
    expect(ev.get('event_name')).toBe('test.event')
  })

  test('sets timestamp as ISO string', () => {
    const before = new Date().toISOString()
    const ev = new WideEvent('test.event')
    const after = new Date().toISOString()
    const ts = ev.get('timestamp') as string
    expect(ts >= before).toBe(true)
    expect(ts <= after).toBe(true)
  })
})

describe('WideEvent set()', () => {
  test('adds fields that are retrievable via get()', () => {
    const ev = new WideEvent('test.event')
    ev.set({ fn_name: 'myFn' })
    expect(ev.get('fn_name')).toBe('myFn')
  })

  test('merges multiple fields', () => {
    const ev = new WideEvent('test.event')
    ev.set({ fn_name: 'myFn', outcome: 'success' })
    expect(ev.get('fn_name')).toBe('myFn')
    expect(ev.get('outcome')).toBe('success')
  })

  test('returns this for chaining', () => {
    const ev = new WideEvent('test.event')
    const result = ev.set({ fn_name: 'a' })
    expect(result).toBe(ev)
  })

  test('overwrites a previously set field', () => {
    const ev = new WideEvent('test.event')
    ev.set({ outcome: 'success' })
    ev.set({ outcome: 'error' })
    expect(ev.get('outcome')).toBe('error')
  })
})

describe('WideEvent get()', () => {
  test('returns undefined for a field that was never set', () => {
    const ev = new WideEvent('test.event')
    expect(ev.get('fn_name')).toBeUndefined()
  })

  test('returns the correct value for a set field', () => {
    const ev = new WideEvent('test.event')
    ev.set({ result_count: 42 })
    expect(ev.get('result_count')).toBe(42)
  })
})

describe('WideEvent flush()', () => {
  beforeEach(() => {
    mockLogger.info.mockClear()
    mockLogger.warn.mockClear()
    mockLogger.error.mockClear()
  })

  test('calls logger.info for a normal outcome', () => {
    const ev = new WideEvent('test.event')
    ev.set({ outcome: 'success' })
    ev.flush()
    expect(mockLogger.info).toHaveBeenCalledTimes(1)
    expect(mockLogger.warn).not.toHaveBeenCalled()
    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  test('calls logger.error when outcome is error', () => {
    const ev = new WideEvent('test.event')
    ev.set({ outcome: 'error' })
    ev.flush()
    expect(mockLogger.error).toHaveBeenCalledTimes(1)
    expect(mockLogger.info).not.toHaveBeenCalled()
    expect(mockLogger.warn).not.toHaveBeenCalled()
  })

  test('calls logger.warn when duration_ms > 1000', async () => {
    // Fake a slow event by overriding performance.now
    let call = 0
    const spy = mock(() => {
      // First call: constructor (start time = 0)
      // Second call: flush (start time + 1500ms)
      return call++ === 0 ? 0 : 1500
    })
    const origPerf = globalThis.performance
    // @ts-ignore — replace for test
    globalThis.performance = { now: spy }

    const ev = new WideEvent('slow.event')
    ev.flush()

    // @ts-ignore — restore
    globalThis.performance = origPerf

    expect(mockLogger.warn).toHaveBeenCalledTimes(1)
    expect(mockLogger.info).not.toHaveBeenCalled()
    expect(mockLogger.error).not.toHaveBeenCalled()
  })

  test('sets duration_ms on flush', () => {
    const ev = new WideEvent('test.event')
    ev.flush()
    const [[fields]] = (mockLogger.info as ReturnType<typeof mock>).mock.calls
    expect(typeof fields.duration_ms).toBe('number')
    expect(fields.duration_ms).toBeGreaterThanOrEqual(0)
  })

  test('passes event_name as the log message', () => {
    const ev = new WideEvent('my.event')
    ev.flush()
    const [[_fields, msg]] = (mockLogger.info as ReturnType<typeof mock>).mock.calls
    expect(msg).toBe('my.event')
  })

  test('does not include event_name in the fields object', () => {
    const ev = new WideEvent('my.event')
    ev.flush()
    const [[fields]] = (mockLogger.info as ReturnType<typeof mock>).mock.calls
    expect(fields.event_name).toBeUndefined()
  })

  test('double flush is a no-op', () => {
    const ev = new WideEvent('test.event')
    ev.flush()
    ev.flush()
    expect(mockLogger.info).toHaveBeenCalledTimes(1)
  })
})
