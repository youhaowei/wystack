import { createDb, createDb as openDatabase } from '../index'

const primary = createDb({ dev: 'pglite://' })

export function createSecondary() {
  return openDatabase({ dev: 'pglite://' })
}

export { primary }
