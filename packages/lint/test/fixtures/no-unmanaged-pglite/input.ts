import { PGlite, PGlite as TestDatabase } from '@electric-sql/pglite'

const primary = new
  PGlite()

function createSecondary() {
  return new TestDatabase()
}
