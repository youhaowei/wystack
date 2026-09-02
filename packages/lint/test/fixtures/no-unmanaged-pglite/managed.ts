import { test } from 'bun:test'
import { createTestDb, createTestPg, useTestPglite } from '@wystack/db/testing'

useTestPglite()

test('uses lifecycle-managed factories', () => {
  createTestPg()
  createTestDb({ dev: 'pglite://' })
})
