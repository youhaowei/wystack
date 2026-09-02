import { expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { createTestPg, useTestPglite } from '@wystack/db/testing'

useTestPglite()

test('innocent file still queries after the bound breach', async () => {
  const pg = createTestPg()
  const result = await pg.query<{ answer: number }>('select 1 as answer')

  expect(result.rows).toEqual([{ answer: 1 }])
  const sentinelPath = process.env.PGLITE_GUARD_SENTINEL
  if (!sentinelPath) throw new Error('PGLITE_GUARD_SENTINEL is required')
  writeFileSync(sentinelPath, 'passed')
})
