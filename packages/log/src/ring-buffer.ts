import type { LogEntry } from './types'

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

  constructor(maxSize = 1000) {
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

// Module-level singleton
let ringBuffer: LogRingBuffer | null = null

export function initRingBuffer(size: number): LogRingBuffer {
  ringBuffer = new LogRingBuffer(size)
  return ringBuffer
}

export function getRingBuffer(): LogRingBuffer | null {
  return ringBuffer
}

export function getRecentLogs(): ReadonlyArray<LogEntry> {
  return ringBuffer?.getEntries() ?? []
}
