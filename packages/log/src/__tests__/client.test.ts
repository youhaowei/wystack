import { describe, test, expect, beforeEach } from 'bun:test'
import { startPageMark, mark, flushPageMark } from '../client'

// client.ts stores active page marks on globalThis.__wystack_page_marks__
const globals = globalThis as Record<string, unknown>

function getActive(): Map<string, unknown> {
  return globals.__wystack_page_marks__ as Map<string, unknown>
}

beforeEach(() => {
  // Reset the shared map between tests
  getActive().clear()
})

describe('startPageMark()', () => {
  test('registers a new page mark', () => {
    startPageMark('home')
    expect(getActive().has('home')).toBe(true)
  })

  test('records start time close to now', () => {
    const before = performance.now()
    startPageMark('home')
    const after = performance.now()
    const entry = getActive().get('home') as { start: number }
    expect(entry.start).toBeGreaterThanOrEqual(before)
    expect(entry.start).toBeLessThanOrEqual(after)
  })

  test('replaces an existing mark with the same name', () => {
    startPageMark('home')
    const first = (getActive().get('home') as { start: number }).start

    startPageMark('home')
    const second = (getActive().get('home') as { start: number }).start

    expect(second).toBeGreaterThanOrEqual(first)
  })
})

describe('mark()', () => {
  test('records elapsed time for a named mark', () => {
    startPageMark('home')
    mark('home', 'data-loaded')
    const entry = getActive().get('home') as { marks: Record<string, number> }
    expect(typeof entry.marks['data-loaded']).toBe('number')
    expect(entry.marks['data-loaded']).toBeGreaterThanOrEqual(0)
  })

  test('is a no-op for an unknown page', () => {
    // Should not throw
    expect(() => mark('nonexistent', 'some-mark')).not.toThrow()
  })

  test('records multiple marks for the same page', () => {
    startPageMark('home')
    mark('home', 'first')
    mark('home', 'second')
    const entry = getActive().get('home') as { marks: Record<string, number> }
    expect('first' in entry.marks).toBe(true)
    expect('second' in entry.marks).toBe(true)
  })

  test('mark values are non-negative integers', () => {
    startPageMark('page')
    mark('page', 'step')
    const entry = getActive().get('page') as { marks: Record<string, number> }
    const value = entry.marks['step']
    expect(Number.isInteger(value)).toBe(true)
    expect(value).toBeGreaterThanOrEqual(0)
  })
})

describe('flushPageMark()', () => {
  test('returns an entry with page name', () => {
    startPageMark('home')
    const result = flushPageMark('home')
    expect(result?.page).toBe('home')
  })

  test('returns an entry with total_ms', () => {
    startPageMark('home')
    const result = flushPageMark('home')
    expect(typeof result?.total_ms).toBe('number')
    expect(result!.total_ms).toBeGreaterThanOrEqual(0)
  })

  test('includes recorded marks in the entry', () => {
    startPageMark('home')
    mark('home', 'data-loaded')
    const result = flushPageMark('home')
    expect(typeof (result as Record<string, unknown>)?.['data-loaded']).toBe('number')
  })

  test('removes the page from active marks after flush', () => {
    startPageMark('home')
    flushPageMark('home')
    expect(getActive().has('home')).toBe(false)
  })

  test('returns undefined for an unknown page', () => {
    const result = flushPageMark('nonexistent')
    expect(result).toBeUndefined()
  })

  test('returns undefined and does not throw for already-flushed page', () => {
    startPageMark('home')
    flushPageMark('home')
    expect(() => flushPageMark('home')).not.toThrow()
    expect(flushPageMark('home')).toBeUndefined()
  })

  test('strips reserved key "page" from marks', () => {
    startPageMark('home')
    // Directly inject a reserved key into the marks map to simulate the case
    const entry = getActive().get('home') as { marks: Record<string, number> }
    entry.marks['page'] = 999
    const result = flushPageMark('home')
    // 'page' should be the page name string, not 999
    expect(result?.page).toBe('home')
    // The numeric 999 should not appear anywhere
    const values = Object.values(result ?? {})
    expect(values).not.toContain(999)
  })

  test('strips reserved key "total_ms" from marks', () => {
    startPageMark('home')
    const entry = getActive().get('home') as { marks: Record<string, number> }
    entry.marks['total_ms'] = 9999
    const result = flushPageMark('home')
    // total_ms should be the computed elapsed time, not 9999
    expect(result?.total_ms).not.toBe(9999)
  })

  test('total_ms is a rounded integer', () => {
    startPageMark('home')
    const result = flushPageMark('home')
    expect(Number.isInteger(result?.total_ms)).toBe(true)
  })

  test('multiple independent pages do not interfere', () => {
    startPageMark('home')
    startPageMark('about')
    mark('home', 'rendered')
    const homeResult = flushPageMark('home')
    const aboutResult = flushPageMark('about')
    expect(homeResult?.page).toBe('home')
    expect(aboutResult?.page).toBe('about')
    expect('rendered' in (homeResult ?? {})).toBe(true)
    expect('rendered' in (aboutResult ?? {})).toBe(false)
  })
})
