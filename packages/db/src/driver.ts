import type { DbConfig, Db } from './types'

/**
 * Create a database connection with dual-driver support.
 * Uses PGlite for local dev, Postgres (or other SQL) for production.
 */
export async function createDb(config: DbConfig): Promise<Db> {
  const url = config.url ?? (process.env.NODE_ENV === 'production' ? config.prod : config.dev)

  if (!url) {
    throw new Error('No database URL provided. Set db.dev, db.prod, or db.url in your config.')
  }

  if (url.startsWith('pglite://')) {
    const path = url.replace('pglite://', '')
    const { PGlite } = await import('@electric-sql/pglite')
    const { drizzle } = await import('drizzle-orm/pglite')
    const client = new PGlite(path)
    return drizzle(client)
  }

  // Default: Postgres
  const pg = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const client = pg.default(url)
  return drizzle(client)
}
