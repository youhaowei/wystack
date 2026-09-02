import { expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createTestDb, useTestPglite } from '@wystack/db/testing'

useTestPglite()
useTestPglite()

const runFixtures = (...files: string[]) => {
  const result = Bun.spawnSync({
    cmd: ['bun', 'test', ...files],
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = new TextDecoder().decode(result.stderr)

  expect(result.exitCode === 0 ? null : { exitCode: result.exitCode, stderr }).toBeNull()
}

test('createTestDb exposes an open PGlite client', async () => {
  const db = await createTestDb({ dev: 'pglite://' })
  const client = db.$client as PGlite

  expect(client.closed).toBe(false)
})

// The shape-based $client registration must keep working across PGlite and Drizzle upgrades.
test('double registration still closes the createTestDb client at one clean drain', () => {
  runFixtures(`${import.meta.dir}/testing-first.fixture.ts`)
})

test('every file registers its own drain even after another file loaded the harness', () => {
  runFixtures(
    `${import.meta.dir}/testing-first.fixture.ts`,
    `${import.meta.dir}/testing-second.fixture.ts`,
  )
})
