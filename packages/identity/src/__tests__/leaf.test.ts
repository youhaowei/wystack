import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

// @wystack/identity is a dependency-free leaf: client bundles depend on it and
// must not pull Hono/Drizzle into a browser build. Enforced here rather than in
// prose so a stray `bun add` fails the suite.
describe('package boundary', () => {
  test('declares no runtime dependencies', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { dependencies?: Record<string, string> }

    expect(Object.keys(manifest.dependencies ?? {})).toEqual([])
  })
})
