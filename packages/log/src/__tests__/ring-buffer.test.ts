import { describe, test, expect, afterEach } from 'bun:test'
import {
  LogRingBuffer,
  DEFAULT_RING_SIZE,
  initRingBuffer,
  getRingBuffer,
  getRecentLogs,
} from '../ring-buffer'
import type { LogEntry } from '../types'

// Helpers
function makeEntry(level: number, msg = 'test'): LogEntry {
  return { level, time: Date.now(), msg }
}

describe('DEFAULT_RING_SIZE', () => {
  test('is exported and equals 1000', () => {
    expect(DEFAULT_RING_SIZE).toBe(1000)
  })
})

describe('LogRingBuffer constructor', () => {
  test('constructs with default maxSize', () => {
    const buf = new LogRingBuffer()
    expect(buf.count()).toBe(0)
  })

  test('constructs with explicit maxSize', () => {
    const buf = new LogRingBuffer(5)
    expect(buf.count()).toBe(0)
  })

  test('throws when maxSize is 0', () => {
    expect(() => new LogRingBuffer(0)).toThrow('LogRingBuffer maxSize must be >= 1')
  })

  test('throws when maxSize is negative', () => {
    expect(() => new LogRingBuffer(-1)).toThrow('LogRingBuffer maxSize must be >= 1')
  })
})

describe('LogRingBuffer push()', () => {
  test('adds an entry', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(30))
    expect(buf.count()).toBe(1)
  })

  test('adds multiple entries up to capacity', () => {
    const buf = new LogRingBuffer(3)
    buf.push(makeEntry(30, 'a'))
    buf.push(makeEntry(30, 'b'))
    buf.push(makeEntry(30, 'c'))
    expect(buf.count()).toBe(3)
  })

  test('evicts oldest entry when at capacity', () => {
    const buf = new LogRingBuffer(3)
    buf.push(makeEntry(30, 'first'))
    buf.push(makeEntry(30, 'second'))
    buf.push(makeEntry(30, 'third'))
    buf.push(makeEntry(30, 'fourth'))

    const entries = buf.getEntries()
    expect(entries.length).toBe(3)
    expect(entries[0].msg).toBe('second')
    expect(entries[2].msg).toBe('fourth')
  })

  test('ring wraps correctly over multiple overflows', () => {
    const buf = new LogRingBuffer(2)
    for (let i = 1; i <= 5; i++) {
      buf.push(makeEntry(30, String(i)))
    }
    const entries = buf.getEntries()
    expect(entries.length).toBe(2)
    expect(entries[0].msg).toBe('4')
    expect(entries[1].msg).toBe('5')
  })
})

describe('LogRingBuffer getEntries()', () => {
  test('returns a copy, not the internal array', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(30))
    const a = buf.getEntries()
    const b = buf.getEntries()
    expect(a).not.toBe(b)
  })

  test('mutating the returned array does not affect the buffer', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(30, 'real'))
    const copy = buf.getEntries() as LogEntry[]
    copy.push(makeEntry(30, 'injected'))
    expect(buf.count()).toBe(1)
  })

  test('returns all entries in insertion order', () => {
    const buf = new LogRingBuffer(5)
    buf.push(makeEntry(30, 'a'))
    buf.push(makeEntry(40, 'b'))
    const entries = buf.getEntries()
    expect(entries[0].msg).toBe('a')
    expect(entries[1].msg).toBe('b')
  })
})

describe('LogRingBuffer getEntriesByLevel()', () => {
  test('filters by trace level (>= 10)', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(10, 'trace-msg'))
    buf.push(makeEntry(30, 'info-msg'))
    const result = buf.getEntriesByLevel('trace')
    expect(result.length).toBe(2)
  })

  test('filters by debug level (>= 20)', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(10, 'trace-only'))
    buf.push(makeEntry(20, 'debug-msg'))
    buf.push(makeEntry(30, 'info-msg'))
    const result = buf.getEntriesByLevel('debug')
    expect(result.length).toBe(2)
    expect(result[0].msg).toBe('debug-msg')
  })

  test('filters by info level (>= 30)', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(10))
    buf.push(makeEntry(20))
    buf.push(makeEntry(30, 'info-msg'))
    buf.push(makeEntry(40, 'warn-msg'))
    const result = buf.getEntriesByLevel('info')
    expect(result.length).toBe(2)
    expect(result[0].msg).toBe('info-msg')
  })

  test('filters by warn level (>= 40)', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(30, 'info'))
    buf.push(makeEntry(40, 'warn'))
    buf.push(makeEntry(50, 'error'))
    const result = buf.getEntriesByLevel('warn')
    expect(result.length).toBe(2)
    expect(result[0].msg).toBe('warn')
  })

  test('filters by error level (>= 50)', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(40, 'warn'))
    buf.push(makeEntry(50, 'error'))
    buf.push(makeEntry(60, 'fatal'))
    const result = buf.getEntriesByLevel('error')
    expect(result.length).toBe(2)
    expect(result[0].msg).toBe('error')
  })

  test('filters by fatal level (>= 60)', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(50, 'error'))
    buf.push(makeEntry(60, 'fatal'))
    const result = buf.getEntriesByLevel('fatal')
    expect(result.length).toBe(1)
    expect(result[0].msg).toBe('fatal')
  })

  test('returns empty array for unknown level name', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(30))
    const result = buf.getEntriesByLevel('verbose')
    expect(result).toEqual([])
  })

  test('returns empty array when buffer is empty', () => {
    const buf = new LogRingBuffer(10)
    expect(buf.getEntriesByLevel('info')).toEqual([])
  })
})

describe('LogRingBuffer count()', () => {
  test('returns 0 for empty buffer', () => {
    expect(new LogRingBuffer(10).count()).toBe(0)
  })

  test('returns entry count', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(30))
    buf.push(makeEntry(30))
    expect(buf.count()).toBe(2)
  })

  test('does not exceed maxSize', () => {
    const buf = new LogRingBuffer(3)
    for (let i = 0; i < 10; i++) buf.push(makeEntry(30))
    expect(buf.count()).toBe(3)
  })
})

describe('LogRingBuffer clear()', () => {
  test('resets count to 0', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(30))
    buf.push(makeEntry(30))
    buf.clear()
    expect(buf.count()).toBe(0)
  })

  test('getEntries returns empty after clear', () => {
    const buf = new LogRingBuffer(10)
    buf.push(makeEntry(30))
    buf.clear()
    expect(buf.getEntries()).toEqual([])
  })

  test('allows adding entries after clear', () => {
    const buf = new LogRingBuffer(2)
    buf.push(makeEntry(30, 'before'))
    buf.clear()
    buf.push(makeEntry(30, 'after'))
    expect(buf.count()).toBe(1)
    expect(buf.getEntries()[0].msg).toBe('after')
  })
})

describe('singleton: initRingBuffer / getRingBuffer / getRecentLogs', () => {
  const globals = globalThis as Record<string, unknown>

  afterEach(() => {
    // Clean up singleton between tests
    delete globals.__wystack_ring_buffer__
  })

  test('getRingBuffer returns null before init', () => {
    expect(getRingBuffer()).toBeNull()
  })

  test('initRingBuffer returns a LogRingBuffer', () => {
    const ring = initRingBuffer(50)
    expect(ring).toBeInstanceOf(LogRingBuffer)
  })

  test('getRingBuffer returns the initialized buffer', () => {
    const ring = initRingBuffer(50)
    expect(getRingBuffer()).toBe(ring)
  })

  test('initRingBuffer replaces the previous singleton', () => {
    const first = initRingBuffer(10)
    const second = initRingBuffer(20)
    expect(getRingBuffer()).toBe(second)
    expect(getRingBuffer()).not.toBe(first)
  })

  test('getRecentLogs returns empty array before init', () => {
    expect(getRecentLogs()).toEqual([])
  })

  test('getRecentLogs returns entries from the active buffer', () => {
    const ring = initRingBuffer(10)
    ring.push(makeEntry(30, 'hello'))
    const logs = getRecentLogs()
    expect(logs.length).toBe(1)
    expect(logs[0].msg).toBe('hello')
  })
})
