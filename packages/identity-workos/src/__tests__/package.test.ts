import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('package boundary', () => {
  test('depends only on the identity seam and JOSE', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> }

    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(['@wystack/identity', 'jose'])
  })
})
