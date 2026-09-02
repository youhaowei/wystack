import { expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import { createTestDb, useTestPglite } from '@wystack/db/testing'

useTestPglite()

let client: PGlite | undefined

test('opens a managed database in the first fixture', async () => {
  const db = await createTestDb({ dev: 'pglite://' })
  client = db.$client as PGlite
  expect(client.closed).toBe(false)
})

test('drains the first fixture before its next test', () => {
  expect(client?.closed).toBe(true)
})
