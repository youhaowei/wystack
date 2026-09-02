import { test } from 'bun:test'
import { createTestPg, useTestPglite } from '@wystack/db/testing'

useTestPglite()

test('leaking file exceeds the live-instance bound', () => {
  for (let index = 0; index <= 8; index += 1) {
    createTestPg()
  }
})
