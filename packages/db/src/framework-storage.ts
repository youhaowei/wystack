import { sql, type SQL } from 'drizzle-orm'

interface FrameworkStorageDb {
  execute(statement: SQL): Promise<unknown>
  transaction<T>(operation: (tx: FrameworkStorageDb) => Promise<T>): Promise<T>
}

/**
 * Serialize framework-table installation per PostgreSQL database and schema.
 * `CREATE TABLE IF NOT EXISTS` can still race in PostgreSQL's internal catalogs
 * across first-use connections, so every framework bootstrap takes the same
 * transaction-scoped advisory lock before issuing idempotent DDL.
 */
export function withFrameworkBootstrapLock<T>(
  raw: FrameworkStorageDb,
  operation: (tx: FrameworkStorageDb) => Promise<T>,
): Promise<T> {
  return raw.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`SELECT pg_advisory_xact_lock(hashtextextended(
      'wystack:framework-bootstrap:' || current_database() || ':' || COALESCE(current_schema(), ''),
      0
    ))`),
    )
    return operation(tx)
  })
}
