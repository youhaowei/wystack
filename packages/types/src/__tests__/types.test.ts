import { describe, test, expect } from 'bun:test'
import { semver, isSemVer, parseSemVer, isoNow, isoFrom, isISOTimestamp } from '../index'
import type { SemVer, ISOTimestamp } from '../index'

describe('SemVer', () => {
  test('creates valid semver', () => {
    const v = semver('1.2.3')
    expect(String(v)).toBe('1.2.3')
    // Type assertion: v is SemVer (branded string), not just string
    const _typed: SemVer = v
    void _typed
  })

  test('rejects invalid semver', () => {
    expect(() => semver('not-a-version')).toThrow(TypeError)
    expect(() => semver('1.2')).toThrow(TypeError)
    expect(() => semver('1.2.3.4')).toThrow(TypeError)
    expect(() => semver('v1.2.3')).toThrow(TypeError)
    expect(() => semver('')).toThrow(TypeError)
  })

  test('isSemVer type guard', () => {
    expect(isSemVer('1.0.0')).toBe(true)
    expect(isSemVer('0.0.0')).toBe(true)
    expect(isSemVer('999.999.999')).toBe(true)
    expect(isSemVer('nope')).toBe(false)
    expect(isSemVer('1.2')).toBe(false)
  })

  test('parseSemVer extracts components', () => {
    const parsed = parseSemVer(semver('2.10.3'))
    expect(parsed).toEqual({ major: 2, minor: 10, patch: 3 })
  })

  test('parseSemVer handles zeroes', () => {
    const parsed = parseSemVer(semver('0.0.0'))
    expect(parsed).toEqual({ major: 0, minor: 0, patch: 0 })
  })
})

describe('ISOTimestamp', () => {
  test('isoNow returns valid ISO string', () => {
    const ts = isoNow()
    expect(new Date(ts).toISOString()).toBe(String(ts))
    // Type assertion
    const _typed: ISOTimestamp = ts
    void _typed
  })

  test('isoFrom accepts Date', () => {
    const d = new Date('2026-03-16T12:00:00.000Z')
    const ts = isoFrom(d)
    expect(String(ts)).toBe('2026-03-16T12:00:00.000Z')
  })

  test('isoFrom accepts ISO string', () => {
    const ts = isoFrom('2026-01-15T00:00:00.000Z')
    expect(String(ts)).toBe('2026-01-15T00:00:00.000Z')
  })

  test('isoFrom accepts date-only string', () => {
    const ts = isoFrom('2026-03-16')
    expect(new Date(ts).toISOString()).toBe(String(ts))
  })

  test('isoFrom rejects invalid input', () => {
    expect(() => isoFrom('not-a-date')).toThrow(TypeError)
    expect(() => isoFrom('')).toThrow(TypeError)
  })

  test('isISOTimestamp type guard', () => {
    expect(isISOTimestamp('2026-03-16T12:00:00.000Z')).toBe(true)
    expect(isISOTimestamp('not-a-date')).toBe(false)
    // Date-only strings are not exact ISO format (toISOString adds time)
    expect(isISOTimestamp('2026-03-16')).toBe(false)
  })
})
