import * as pglite from '@electric-sql/pglite'
import * as workerPglite from '@electric-sql/pglite/worker'

export const primary = new pglite.PGlite()
export const worker = new workerPglite.PGlite()
