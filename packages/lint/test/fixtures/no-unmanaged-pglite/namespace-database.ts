import * as db from '@wystack/db'

export const unmanaged = db.createDb({ dev: 'pglite://' })
