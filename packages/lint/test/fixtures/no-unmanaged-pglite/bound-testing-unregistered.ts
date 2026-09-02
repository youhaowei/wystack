import { test } from 'bun:test'
import * as testing from '@wystack/db/testing'

const makePg = testing.createTestPg
const { createTestDb: makeDb } = testing

test('forgets lifecycle registration', () => {
  makePg()
  makeDb({ dev: 'pglite://' })
})
