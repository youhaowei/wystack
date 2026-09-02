import { test } from 'bun:test'
import * as testing from '@wystack/db/testing'

testing.useTestPglite()

test('uses the registered namespace factory', () => {
  testing.createTestPg()
  testing.createTestDb({ dev: 'pglite://' })
})
