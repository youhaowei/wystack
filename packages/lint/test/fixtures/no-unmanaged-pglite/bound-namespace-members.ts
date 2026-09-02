import * as pglite from '@electric-sql/pglite'
import * as db from '@wystack/db'

const Pg = pglite.PGlite
const { PGlite: OtherPg } = pglite
const create = db.createDb
const { createDb: open } = db

new Pg()
new OtherPg()
create({ dev: 'pglite://' })
open({ dev: 'pglite://' })
