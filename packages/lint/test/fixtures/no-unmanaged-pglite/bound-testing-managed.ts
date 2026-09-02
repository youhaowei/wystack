import { test } from 'bun:test'
import * as testing from '@wystack/db/testing'

const makePg = testing.createTestPg
const { createTestDb: makeDb, useTestPglite: register } = testing

register()

test('registers bound namespace factories', () => {
  makePg()
  makeDb({ dev: 'pglite://' })
})
