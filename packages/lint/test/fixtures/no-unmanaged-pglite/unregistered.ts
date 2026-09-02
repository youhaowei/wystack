import { test } from 'bun:test'
import { createTestDb as openTestDatabase } from '@wystack/db/testing'

test('forgets lifecycle registration', () => {
  openTestDatabase({ dev: 'pglite://' })
})
