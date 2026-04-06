import type { LogEntry } from './types'

export const DEFAULT_RING_SIZE = 1000

const LEVEL_NAMES: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

export class LogRingBuffer {
  private entries: LogEntry[] = []
  private maxSize: number

  constructor(maxSize = DEFAULT_RING_SIZE) {
    if (maxSize < 1) throw new Error('LogRingBuffer maxSize must be >= 1')
    this.maxSize = maxSize
  }

  push(entry: LogEntry) {
    if (this.entries.length >= this.maxSize) {
      this.entries.shift()
    }
    this.entries.push(entry)
  }

  getEntries(): ReadonlyArray<LogEntry> {
    return [...this.entries]
  }

  getEntriesByLevel(level: string): ReadonlyArray<LogEntry> {
    const num = LEVEL_NAMES[level]
    if (num === undefined) return []
    return this.entries.filter((e) => e.level >= num)
  }

  count() {
    return this.entries.length
  }

  clear() {
    this.entries = []
  }
}

// Singleton — survives HMR via globalThis (same pattern as logger)
const globals = globalThis as Record<string, unknown>

export function initRingBuffer(size: number): LogRingBuffer {
  const ring = new LogRingBuffer(size)
  globals.__wystack_ring_buffer__ = ring
  return ring
}

export function getRingBuffer(): LogRingBuffer | null {
  return (globals.__wystack_ring_buffer__ as LogRingBuffer) ?? null
}

export function getRecentLogs(): ReadonlyArray<LogEntry> {
  return getRingBuffer()?.getEntries() ?? []
}
