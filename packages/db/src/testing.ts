/**
 * Test-only helpers for PGlite lifecycle management. This subpath is not part
 * of the runtime surface.
 */
import { afterAll, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { createDb } from './driver'
import type { Db, DbConfig } from './types'

const live = new Set<PGlite>()

const drain = async () => {
  const pending = [...live]
  // Clear before awaiting so one disposal failure is reported once and cannot poison later tests.
  live.clear()
  const results = await Promise.allSettled(
    pending.map((pg) => (pg.closed ? Promise.resolve() : pg.close())),
  )
  const failures = results.filter((result) => result.status === 'rejected')

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      'PGlite test instance disposal failed',
    )
  }
}

/**
 * Register lifecycle hooks from each test file's own module body. An import-time
 * hook attaches to only the first file that evaluates this module, not every
 * file that imports it. Double registration is harmless because the first drain
 * clears the shared set; a module-level guard would wrongly suppress later files.
 *
 * Never call this at module scope in a shared helper. Expose a composed `use...()`
 * function that each importing test file calls from its own module body instead.
 */
export function useTestPglite(): void {
  // Drain before the next test so a file's own afterEach hooks can still use its database.
  beforeEach(drain)
  afterAll(drain)
}

export function createTestPg(...args: ConstructorParameters<typeof PGlite>): PGlite {
  const pg = new PGlite(...args)
  live.add(pg)
  return pg
}

export async function createTestDb(config: DbConfig): Promise<Db> {
  const db = await createDb(config)
  const client: unknown = db.$client

  if (
    typeof client === 'object' &&
    client !== null &&
    'close' in client &&
    typeof client.close === 'function'
  ) {
    live.add(client as PGlite)
  }

  return db
}
