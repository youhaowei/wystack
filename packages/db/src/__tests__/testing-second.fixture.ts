import { expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createTestDb, useTestPglite } from '@wystack/db/testing'

useTestPglite()

const db = await createTestDb({ dev: 'pglite://' })
const client = db.$client as PGlite

test('this file drains its module-created client before the test', () => {
  expect(client.closed).toBe(true)
})
