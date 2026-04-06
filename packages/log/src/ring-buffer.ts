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
  private entries: (LogEntry | undefined)[]
  private head = 0
  private _count = 0
  private maxSize: number

  constructor(maxSize = DEFAULT_RING_SIZE) {
    if (maxSize < 1) throw new Error('LogRingBuffer maxSize must be >= 1')
    this.maxSize = maxSize
    this.entries = new Array(maxSize)
  }

  push(entry: LogEntry) {
    this.entries[this.head] = entry
    this.head = (this.head + 1) % this.maxSize
    if (this._count < this.maxSize) this._count++
  }

  getEntries(): ReadonlyArray<LogEntry> {
    if (this._count < this.maxSize) {
      return this.entries.slice(0, this._count) as LogEntry[]
    }
    // Insertion order: oldest (head) to newest (head - 1)
    return [...this.entries.slice(this.head), ...this.entries.slice(0, this.head)] as LogEntry[]
  }

  getEntriesByLevel(level: string): ReadonlyArray<LogEntry> {
    const num = LEVEL_NAMES[level]
    if (num === undefined) return []
    return this.getEntries().filter((e) => e.level >= num)
  }

  count() {
    return this._count
  }

  clear() {
    this.entries = new Array(this.maxSize)
    this.head = 0
    this._count = 0
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

export function clearRingBuffer(): void {
  delete globals.__wystack_ring_buffer__
}

export function getRecentLogs(): ReadonlyArray<LogEntry> {
  return getRingBuffer()?.getEntries() ?? []
}
