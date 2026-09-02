import * as db from '../index'

const create = db.createDb
const { createDb: open } = db

create({ dev: 'pglite://' })
open({ dev: 'pglite://' })
