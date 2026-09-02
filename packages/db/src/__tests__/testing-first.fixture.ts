import { expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createTestDb, useTestPglite } from '@wystack/db/testing'

useTestPglite()
useTestPglite()

const db = await createTestDb({ dev: 'pglite://' })
const client = db.$client as PGlite

test('double registration drains a module-created client before the test', () => {
  expect(client.closed).toBe(true)
})
