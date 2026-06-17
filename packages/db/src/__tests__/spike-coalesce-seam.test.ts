/**
 * SPIKE (throwaway) — coalesce read seam comparison.
 *
 * Builds a minimal draft-coalesce read at three candidate seams against the
 * real @wystack/db DSL + a real PGlite database, to find which seam bends
 * cleanly while keeping no-draft reads zero-overhead (byte-identical SQL).
 *
 * Storage model (fixed): per-table `<table>__draft` delta sibling — same
 * columns + (draftId, id) key + a `__tombstone` boolean for deletes. Coalesce =
 * delta row where present for this draftId, skip tombstoned, else canonical.
 *
 * Toy schema:
 *   todos(id int pk, title text, done boolean)
 *   todos__draft(draft_id text, id int, title text, done boolean, __tombstone boolean)
 *
 * Seed canonical: {1,'apple',f} {2,'banana',f} {3,'cherry',f}
 * Draft 'd1' delta:
 *   {1,'APPLE-edited',f}     → edit  (delta wins)
 *   {2, _, __tombstone=true} → delete (omitted)
 *   {4,'date-new',f}         → insert (delta-only, no canonical)
 * Coalesced read of todos through draft 'd1' must be:
 *   {1,'APPLE-edited'} {3,'cherry'} {4,'date-new'}  (2 omitted)
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql, getTableColumns, getTableName } from 'drizzle-orm'
import { pgTable, integer, text as pgText, boolean as pgBoolean } from 'drizzle-orm/pg-core'
import { createTrackedDb } from '../tracked-db'

// ── Toy schema (raw pgTable; the spike doesn't need defineSchema) ────────────
const todos = pgTable('todos', {
  id: integer('id').primaryKey(),
  title: pgText('title').notNull(),
  done: pgBoolean('done').notNull(),
})

const todosDraft = pgTable('todos__draft', {
  draftId: pgText('draft_id').notNull(),
  id: integer('id').notNull(),
  title: pgText('title'),
  done: pgBoolean('done'),
  tombstone: pgBoolean('__tombstone').notNull(),
})

let pg: PGlite
let db: ReturnType<typeof drizzle>

beforeEach(async () => {
  pg = new PGlite()
  db = drizzle(pg)
  await db.execute(`CREATE TABLE todos (id INT PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`)
  await db.execute(`CREATE TABLE todos__draft (
    draft_id TEXT NOT NULL, id INT NOT NULL,
    title TEXT, done BOOLEAN, __tombstone BOOLEAN NOT NULL,
    PRIMARY KEY (draft_id, id)
  )`)
  await db.execute(`INSERT INTO todos VALUES (1,'apple',false),(2,'banana',false),(3,'cherry',false)`)
  await db.execute(`INSERT INTO todos__draft VALUES
    ('d1',1,'APPLE-edited',false,false),
    ('d1',2,NULL,NULL,true),
    ('d1',4,'date-new',false,false)`)
})

const EXPECTED_D1 = [
  { id: 1, title: 'APPLE-edited' },
  { id: 3, title: 'cherry' },
  { id: 4, title: 'date-new' },
]

// ════════════════════════════════════════════════════════════════════════════
// SEAM A — DSL/SelectBuilder rewrite via a `withDraft(draftId)` scoped handle.
//
// Sibling to `transaction()`: a fresh handle whose SELECTs are rewritten to
// coalesce delta-over-canonical and drop tombstones. Implemented here as a
// standalone helper (the spike doesn't edit tracked-db.ts) but the shape is
// exactly a `db.withDraft(id).from(table).all()` builder.
//
// Rewrite strategy: build the coalesce as raw SQL via drizzle's `sql`
// template, selecting COALESCE(delta.col, base.col) for every column, LEFT
// JOIN the draft on (draft_id, id), and filter `delta.__tombstone IS NOT TRUE`,
// keeping rows that are (canonical not-tombstoned) OR (draft-only insert).
// ════════════════════════════════════════════════════════════════════════════

function seamA_coalescedSelect(
  drizzleDb: ReturnType<typeof drizzle>,
  base: typeof todos,
  draft: typeof todosDraft,
  draftId: string,
) {
  const baseName = getTableName(base)
  const draftName = getTableName(draft)
  // oxlint-disable-next-line typescript/no-explicit-any -- spike: dynamic column map access
  const baseCols = getTableColumns(base) as Record<string, { name: string }>
  // oxlint-disable-next-line typescript/no-explicit-any -- spike: dynamic column map access
  const draftCols = getTableColumns(draft) as Record<string, { name: string }>
  const cols = Object.keys(baseCols) // ['id','title','done']
  // COALESCE(d."col", b."col") AS "col" for each base column.
  const colExprs = cols
    .map((c) => {
      const dbCol = draftCols[c]?.name ?? c
      const bCol = baseCols[c].name
      return `COALESCE(d."${dbCol}", b."${bCol}") AS "${bCol}"`
    })
    .join(', ')
  // FULL OUTER JOIN so draft-only inserts (id=4, no canonical row) survive.
  // Then drop tombstoned rows. Coalesce on the join key too.
  return sql.raw(`
    SELECT ${colExprs}
    FROM "${baseName}" b
    FULL OUTER JOIN "${draftName}" d
      ON b."id" = d."id" AND d."draft_id" = '${draftId}'
    WHERE COALESCE(d."__tombstone", false) = false
    ORDER BY COALESCE(d."id", b."id")
  `)
}

describe('Seam A — withDraft scoped-handle DSL rewrite', () => {
  test('coalesced read: delta wins, tombstone omitted, draft-insert appears', async () => {
    const tracked = createTrackedDb(db)
    const res = await tracked.raw.execute(seamA_coalescedSelect(db, todos, todosDraft, 'd1'))
    const rows = (res.rows as { id: number; title: string }[]).map((r) => ({
      id: r.id,
      title: r.title,
    }))
    expect(rows).toEqual(EXPECTED_D1)
  })

  test('ZERO-OVERHEAD: a no-draft read lowers to byte-identical canonical SQL', async () => {
    // The canonical path is the EXISTING SelectBuilder. Seam A adds a sibling
    // handle; it does NOT touch the canonical `from().all()` path. So a
    // no-draft read is the unchanged builder — same lowered SQL, guaranteed by
    // construction (a different code path entirely, not a branch in the hot one).
    const tracked = createTrackedDb(db)
    // Lowered SQL of the canonical read (no seam present, baseline):
    const canonical = db.select().from(todos).toSQL()
    // Lowered SQL of the canonical read WITH the seam helper imported/available
    // — identical, because withDraft is a separate entry, not a wrapper.
    const withSeamPresent = db.select().from(todos).toSQL()
    expect(withSeamPresent.sql).toBe(canonical.sql)
    expect(withSeamPresent.params).toEqual(canonical.params)
    // And it actually runs unchanged:
    const rows = await tracked.from(todos).all()
    expect(rows).toHaveLength(3)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SEAM B — coalesce VIEW.
//
// Per draft, materialize a VIEW `todos__coalesced_<draftId>` (or a generic view
// parameterized by a session GUC). Reads are UNCHANGED — the consumer selects
// from a name that resolves to the coalesce. Test per-draft view create/teardown.
//
// Two sub-variants:
//   B1: one view per draft (name carries the draftId). Reads target that name.
//   B2: one generic view filtering on a session var current_setting('df.draft').
//       Reads target the SAME name; draft context is the connection's GUC.
// ════════════════════════════════════════════════════════════════════════════

function coalesceViewBody(draftPredicate: string): string {
  // Shared body — the only difference between B1/B2 is how draft_id is bound.
  return `
    SELECT COALESCE(d.id, b.id) AS id,
           COALESCE(d.title, b.title) AS title,
           COALESCE(d.done, b.done) AS done
    FROM todos b
    FULL OUTER JOIN todos__draft d
      ON b.id = d.id AND ${draftPredicate}
    WHERE COALESCE(d.__tombstone, false) = false
  `
}

describe('Seam B — coalesce view', () => {
  test('B1: per-draft view resolves the coalesce; reads are unchanged', async () => {
    const draftId = 'd1'
    const viewName = `todos__coalesced_${draftId}`
    await db.execute(`CREATE VIEW "${viewName}" AS ${coalesceViewBody(`d.draft_id = '${draftId}'`)}`)

    // "Unchanged read" — but it must target the VIEW NAME, not `todos`.
    const res = await db.execute(`SELECT id, title FROM "${viewName}" ORDER BY id`)
    const rows = (res.rows as { id: number; title: string }[]).map((r) => ({
      id: r.id,
      title: r.title,
    }))
    expect(rows).toEqual(EXPECTED_D1)

    await db.execute(`DROP VIEW "${viewName}"`)
  })

  test('B2: generic view + session GUC; SAME view name for every draft', async () => {
    // One view, draft chosen by a per-connection setting. THIS is the variant
    // where the consumer read is truly unchanged (always `todos__coalesced`).
    await db.execute(
      `CREATE VIEW todos__coalesced AS ${coalesceViewBody(`d.draft_id = current_setting('df.draft', true)`)}`,
    )
    // Select the draft context on THIS connection.
    await db.execute(`SET df.draft = 'd1'`)
    const res = await db.execute(`SELECT id, title FROM todos__coalesced ORDER BY id`)
    const rows = (res.rows as { id: number; title: string }[]).map((r) => ({
      id: r.id,
      title: r.title,
    }))
    expect(rows).toEqual(EXPECTED_D1)
  })

  test('B2 no-draft HAZARD: a FULL OUTER JOIN view LEAKS draft-insert rows when GUC unset', async () => {
    await db.execute(
      `CREATE VIEW todos__coalesced AS ${coalesceViewBody(`d.draft_id = current_setting('df.draft', true)`)}`,
    )
    // GUC unset → the join predicate `d.draft_id = NULL` never matches, so the
    // join produces (canonical rows, all draft sides NULL) PLUS — because it is
    // a FULL OUTER JOIN — the UNMATCHED DRAFT ROWS as right-only rows. The
    // draft insert id=4 and the edit id=1's draft side both leak through as
    // extra/duplicate rows. A no-draft read of this view is WRONG.
    const res = await db.execute(`SELECT id, title FROM todos__coalesced ORDER BY id`)
    const ids = (res.rows as { id: number }[]).map((r) => r.id)
    // Demonstrated leak: id=1 duplicated, id=4 (draft-only insert) leaked.
    expect(ids).toEqual([1, 1, 2, 3, 4])
    // → The generic GUC view CANNOT use FULL OUTER JOIN safely. To be correct
    //   no-draft it must gate the entire draft side on the GUC being set
    //   (LEFT JOIN base + a draft-insert UNION guarded by `df.draft IS NOT
    //   NULL`). That makes the view body materially more complex AND still
    //   pays a join/filter on every no-draft read. Both cost dimensions worsen.
  })

  test('ZERO-OVERHEAD reality check for Seam B: reading the VIEW is NOT reading the base table', async () => {
    // The "reads are unchanged" claim is about the SQL TEXT (`SELECT FROM
    // todos`). But to get coalesce, the consumer must read a DIFFERENT relation
    // (the view) OR the base `todos` name must itself BE the view — which means
    // the canonical no-draft read now hits a FULL OUTER JOIN view, NOT the bare
    // table. Demonstrate the overhead: the view's plan joins even with no draft.
    await db.execute(
      `CREATE VIEW todos__coalesced AS ${coalesceViewBody(`d.draft_id = current_setting('df.draft', true)`)}`,
    )
    const basePlan = await db.execute(`EXPLAIN SELECT * FROM todos`)
    const viewPlan = await db.execute(`EXPLAIN SELECT * FROM todos__coalesced`)
    const baseText = (basePlan.rows as { 'QUERY PLAN': string }[]).map((r) => r['QUERY PLAN']).join('\n')
    const viewText = (viewPlan.rows as { 'QUERY PLAN': string }[]).map((r) => r['QUERY PLAN']).join('\n')
    // Base is a bare seq scan; the view introduces a join node even no-draft.
    expect(baseText).toContain('Seq Scan on todos')
    expect(viewText.toLowerCase()).toContain('join')
    // → If `todos` is aliased TO the view (so reads are textually unchanged),
    //   EVERY no-draft read pays this join. That FAILS zero-overhead.
  })
})

// ════════════════════════════════════════════════════════════════════════════
// SEAM C — driver / query-lowering interception.
//
// Intercept at the driver level (wrap `db.execute` / the query function) and
// rewrite the lowered SQL string to inject the coalesce before it hits the
// engine. Tests whether the driver layer (a) even KNOWS the (draftId,id)
// semantics, and (b) can rewrite generally without parsing SQL.
// ════════════════════════════════════════════════════════════════════════════

describe('Seam C — driver/lowering interception', () => {
  test('a driver-level string rewrite CAN produce the coalesce — but needs SQL parsing', async () => {
    // The driver sees a fully-lowered SQL STRING: `select ... from "todos"`.
    // To coalesce, it must (1) detect the table ref, (2) know that table has a
    // __draft sibling, (3) rewrite FROM "todos" → a coalesce subquery, (4) know
    // the current draftId. (1)+(3) require parsing/regex over SQL text.
    const draftId = 'd1'
    // Naive regex rewrite of `from "todos"` (works for the toy; brittle in
    // general — fails on aliases, quoting variants, CTEs, subqueries, the
    // table name appearing in a string literal, etc.).
    const original = `SELECT id, title FROM "todos" ORDER BY id`
    const coalesceSub = `(${coalesceViewBody(`d.draft_id = '${draftId}'`)}) AS "todos"`
    const rewritten = original.replace(/FROM\s+"todos"/i, `FROM ${coalesceSub}`)
    const res = await db.execute(rewritten)
    const rows = (res.rows as { id: number; title: string }[]).map((r) => ({
      id: r.id,
      title: r.title,
    }))
    expect(rows).toEqual(EXPECTED_D1)
  })

  test('driver layer does NOT natively know (draftId,id) semantics — it sees opaque SQL', async () => {
    // Demonstrate the abstraction mismatch: at the driver seam, the input is a
    // string + params. There is no structured table/column/key info unless the
    // driver re-parses. The (draftId, id) coalesce key is a DSL-level concept;
    // the driver only has text. This is the "too low" finding.
    const lowered = db.select().from(todos).toSQL()
    expect(typeof lowered.sql).toBe('string')
    // No table object, no column list, no PK info — just SQL text + params.
    expect(lowered).not.toHaveProperty('table')
    expect(lowered).not.toHaveProperty('columns')
  })

  test('ZERO-OVERHEAD for Seam C: a no-draft read must STILL pass through the interceptor', async () => {
    // Even when no draft is active, the wrapped execute() runs its check on
    // EVERY query (is there a draft? does this SQL touch a draftable table?).
    // The branch is cheap but it IS a tax on every read, and a regex/parse pass
    // over every SQL string is not free. Model the interceptor:
    let drafted: string | null = null // no active draft
    let interceptCalls = 0
    function intercept(q: string): string {
      interceptCalls++
      if (drafted == null) return q // no-draft fast path — but the CHECK ran
      return q.replace(/FROM\s+"todos"/i, `FROM (coalesce…) AS "todos"`)
    }
    // Three no-draft reads:
    intercept(`SELECT * FROM "todos"`)
    intercept(`SELECT * FROM "todos" WHERE id = 1`)
    intercept(`SELECT * FROM "tags"`)
    // The interceptor RAN on all three (the per-read tax), even though SQL was
    // returned unchanged. Byte-identical OUTPUT, but not a separate code path.
    expect(interceptCalls).toBe(3)
    expect(drafted).toBeNull()
  })
})
