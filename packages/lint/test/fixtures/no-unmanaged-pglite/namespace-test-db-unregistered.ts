import { test } from 'bun:test'
import * as testing from '@wystack/db/testing'

test('forgets lifecycle registration', () => {
  testing.createTestDb({ dev: 'pglite://' })
})
