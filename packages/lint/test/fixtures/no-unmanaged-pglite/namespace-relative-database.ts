import * as db from '../index'

export const unmanaged = db.createDb({ dev: 'pglite://' })
