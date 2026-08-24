import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { integer, pgTable, text } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createDrizzleTracker, enumerateDraftRowChanges } from '../src/drizzle-tracker'
import { eq, gt } from '../src/operators'

const rows = pgTable('benchmark_rows', {
  id: integer('id').primaryKey(),
  label: text('label').notNull(),
  score: integer('score').notNull(),
})

async function measure<T>(fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now()
  const value = await fn()
  return { ms: performance.now() - start, value }
}

async function relationBytes(db: ReturnType<typeof drizzle>): Promise<number | null> {
  try {
    const result = await db.execute(sql`
      SELECT pg_total_relation_size('wystack_draft_row_changes')::bigint AS bytes
    `)
    return Number((result as { rows: Array<{ bytes: unknown }> }).rows[0]?.bytes)
  } catch {
    return null
  }
}

async function run(n: number, m: number) {
  const pg = new PGlite()
  const db = drizzle(pg)
  for (const statement of [
    `CREATE TABLE benchmark_rows (id INTEGER PRIMARY KEY, label TEXT NOT NULL, score INTEGER NOT NULL)`,
    `CREATE INDEX benchmark_rows_score_id_idx ON benchmark_rows (score DESC, id ASC)`,
    `CREATE TABLE wystack_draft_row_changes (
      draft_id TEXT NOT NULL, table_key TEXT NOT NULL,
      tenant_key_text TEXT NOT NULL DEFAULT '', tenant_key JSONB,
      row_key_text TEXT NOT NULL, row_key JSONB NOT NULL,
      operation TEXT NOT NULL, base_exists BOOLEAN NOT NULL,
      base_revision JSONB, fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (draft_id, table_key, tenant_key_text, row_key_text))`,
    `INSERT INTO benchmark_rows (id, label, score)
     SELECT i, 'row-' || i::text, i % 1000 FROM generate_series(1, ${n}) i`,
  ]) {
    await db.execute(sql.raw(statement))
  }

  const tracked = createDrizzleTracker(db)
  const draft = tracked.withDraft(`bench-${n}-${m}`)
  const writes = await measure(async () => {
    for (let i = 1; i <= m; i++) {
      await draft
        .from(rows)
        .where(eq('id', i))
        .update({ score: 2000 - i })
    }
  })

  // Warm each query once so the recorded number measures the contender rather
  // than Wasm/module initialization.
  await draft
    .from(rows)
    .where(eq('id', Math.min(m, n)))
    .first()
  await draft.from(rows).where(gt('score', 500)).orderBy('score', 'desc').limit(20).all()
  await enumerateDraftRowChanges(db, `bench-${n}-${m}`)

  const point = await measure(async () => {
    for (let i = 0; i < 20; i++) {
      await draft
        .from(rows)
        .where(eq('id', Math.min(m, n)))
        .first()
    }
  })
  const filtered = await measure(async () => {
    for (let i = 0; i < 10; i++) {
      await draft.from(rows).where(gt('score', 500)).orderBy('score', 'desc').limit(20).all()
    }
  })
  const enumeration = await measure(() => enumerateDraftRowChanges(db, `bench-${n}-${m}`))
  const bytes = await relationBytes(db)
  await pg.close()

  return {
    n,
    m,
    writeTotalMs: Number(writes.ms.toFixed(3)),
    writePerChangeMs: Number((writes.ms / m).toFixed(3)),
    pointLookupMeanMs: Number((point.ms / 20).toFixed(3)),
    filteredOrderLimitMeanMs: Number((filtered.ms / 10).toFixed(3)),
    enumerationMs: Number(enumeration.ms.toFixed(3)),
    enumeratedRows: enumeration.value.length,
    relationBytes: bytes,
    bytesPerChange: bytes === null ? null : Number((bytes / m).toFixed(1)),
  }
}

const results = []
for (const n of [100, 10_000, 100_000]) {
  for (const m of [1, 10]) results.push(await run(n, m))
}
console.log(JSON.stringify({ engine: 'PGlite 0.3.16', results }, null, 2))
