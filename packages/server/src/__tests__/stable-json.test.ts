import { describe, expect, test } from 'bun:test'
import { stableJson } from '../stable-json'

describe('stableJson', () => {
  test('sorts object keys recursively while preserving array order', () => {
    expect(stableJson({ z: [{ b: 2, a: 1 }], a: undefined })).toBe(
      '{"a":undefined,"z":[{"a":1,"b":2}]}',
    )
  })

  test('preserves primitive encodings', () => {
    expect(stableJson(undefined)).toBe('undefined')
    expect(stableJson(null)).toBe('null')
    expect(stableJson(false)).toBe('false')
    expect(stableJson(3)).toBe('3')
    expect(stableJson('value')).toBe('"value"')
  })

  test('tags Dates so they differ from the same ISO string', () => {
    const iso = '2026-01-01T00:00:00.000Z'

    expect(stableJson(new Date(iso))).toBe(`date:${JSON.stringify(iso)}`)
    expect(stableJson(new Date(iso))).not.toBe(stableJson(iso))
  })
})
