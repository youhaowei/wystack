import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('package boundary', () => {
  test('depends only on @wystack/identity at runtime', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> }

    expect(manifest.dependencies).toEqual({ '@wystack/identity': 'workspace:*' })
  })
})
