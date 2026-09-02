import { test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'

const guardErrors: unknown[] = []

for (let index = 0; index <= 10; index += 1) {
  try {
    // oxlint-disable-next-line wystack/no-unmanaged-pglite -- this fixture exercises the runtime guard directly
    new PGlite()
  } catch (error) {
    guardErrors.push(error)
  }
}

test('reports only the first live-instance bound breach', () => {
  if (guardErrors.length !== 1) {
    throw new Error(`expected one PGlite bound breach, received ${guardErrors.length}`)
  }

  throw guardErrors[0]
})
