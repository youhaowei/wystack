import { createDb, createDb as openDatabase } from '@wystack/db'

const primary = createDb({ dev: 'pglite://' })

function createSecondary() {
  return openDatabase({ dev: 'pglite://' })
}
