# SPIKE YW-284 — Coalesce read seam comparison (for YW-120)

**Throwaway.** The learning is the deliverable. Code lives at
`packages/db/src/__tests__/spike-coalesce-seam.test.ts` (9 tests, all green) as
executable evidence. Do **not** merge.

De-risks the YW-120 draft-coalesce primitive — the bottom of the
draft → assistant stack — by building a minimal coalesce read at three candidate
seams against the **real** `@wystack/db` DSL + real PGlite, and judging which
bends cleanly END-TO-END (WyStack cleanliness **and** DashFrame consumer
ergonomics) while keeping no-draft reads zero-overhead.

## Storage model (fixed, not re-litigated)

Per-table `<table>__draft` delta sibling: same columns + `(draft_id, id)` key +
`__tombstone boolean`. Coalesce = delta row where present for this draftId, skip
tombstoned, else canonical. Toy: `todos(id,title,done)` +
`todos__draft(draft_id,id,title,done,__tombstone)`. Canonical rows 1/2/3; draft
`d1` = edit(1), tombstone(2), insert(4). Correct coalesced read = `{1
APPLE-edited, 3 cherry, 4 date-new}`.

---

## TL;DR

**Winner: Seam A (`db.withDraft(draftId)` scoped handle).** It is the only seam
that is *simultaneously* (1) byte-identical zero-overhead for no-draft reads **by
construction** (a separate code path, not a branch in the hot path), (2)
app-agnostic, (3) a true sibling to `transaction()`, and (4) — the end-to-end
clincher — injectable **once** at DashFrame's existing `ctx.db` construction
seam, so draft-awareness costs **zero changes** to the ~30 artifact read/write
call sites in `app-artifacts.ts` / `commands.ts`.

| Seam | Bends cleanly | Zero-overhead no-draft | Tombstone | App-agnostic | Sibling to `transaction()` | DashFrame fit | Rank |
|------|---------------|------------------------|-----------|--------------|----------------------------|---------------|------|
| **A — `withDraft` handle** | ✅ mirrors `transaction()` | ✅ **byte-identical, separate path** | ✅ clean | ✅ pure SQL-shape | ✅ literal sibling | ✅ inject once at `ctx.db` | **1** |
| **B — coalesce view** | ⚠️ DDL lifecycle leaks into runtime | ❌ join taxes every read *or* reads must target a different relation | ✅ in view body | ⚠️ view-naming convention is app knowledge | ❌ foreign (DDL, not a handle) | ⚠️ context moves to GUC/connection, not free | 2 |
| **C — driver interception** | ❌ fights the abstraction | ❌ interceptor runs on every read | ⚠️ needs SQL parsing | ⚠️ driver must know `__draft` convention | ❌ wrong layer | ❌ magic, leak-prone context | 3 |

---

## Zero-overhead verdict (the load-bearing test)

Baseline lowered SQL of a no-draft read (real `.toSQL()` output, captured):

```
select "id", "title", "done" from "todos"            -- params: []
select "id", "title", "done" from "todos" where "todos"."id" = $1   -- params: [1]
```

A bare table scan. The test asks of each seam: **does a no-draft read still lower
to exactly this?**

- **Seam A — PASS, by construction.** `withDraft()` is a *separate handle*
  (sibling to `transaction()`), not a wrapper on the canonical `from().all()`
  path. A request with no draft uses the normal tracker and the normal builder —
  the seam's code never runs. The test asserts `withSeamPresent.sql ===
  canonical.sql` and `params` deep-equal. Zero branch, zero tax. **This is the
  decisive property and only Seam A has it cleanly.**

- **Seam B — FAIL.** "Reads are unchanged" is true only of the SQL *text*. To get
  coalesce the consumer must read a *different relation* (the view). If you
  preserve the text by aliasing the base name **to** the view, then every
  no-draft read now hits a `FULL OUTER JOIN` view instead of the bare table. The
  test captures `EXPLAIN`: base = `Seq Scan on todos`; view = a `join` node even
  with no draft active. Every no-draft read pays the join. Tax on the hot path.

- **Seam C — FAIL.** Even with no active draft, the wrapped `execute()` runs its
  check (is a draft active? does this SQL touch a draftable table?) on *every*
  query. The test models the interceptor and asserts it is invoked on all three
  no-draft reads. Output is byte-identical, but it is not a separate code path —
  it is a per-read tax (and a regex/parse pass over every SQL string is not free).

---

## Seam A — `db.withDraft(draftId)` scoped DSL handle  ✅ WINNER

**How it bends.** A fresh handle, sibling to `transaction()`, whose SELECTs are
rewritten to `COALESCE(delta.col, base.col)` over a join on `(draft_id, id)`,
filtering `__tombstone`. The spike builds the coalesced SELECT via drizzle's
`sql` template using `getTableColumns` / `getTableName` introspection — exactly
the introspection the existing `SelectBuilder` already uses (`tracked-db.ts`
uses `getTableColumns`/`getTableName`). The test proves the coalesced read
returns `{1 APPLE-edited, 3 cherry, 4 date-new}`: delta wins, tombstone omitted,
draft-only insert appears.

**Tombstone handling — clean.** `WHERE COALESCE(d."__tombstone", false) = false`
drops deletes; nothing leaks. Ergonomic and local to the rewrite.

**App-agnostic — yes.** The rewrite is pure SQL shape (`<t>` + `<t>__draft`,
`(draft_id, id)`, `__tombstone`). The *convention* (which tables have drafts) is
the only app input and rides in as a parameter/registry, not baked into
`@wystack/db`.

**Sibling to `transaction()` — literally.** `transaction()` is
`createTrackedDb(txHandle)` — a fresh tracker over a scoped handle. `withDraft`
is `createTrackedDb(drizzleDb)` carrying a `draftId` that the builder consults.
Same shape, same lifecycle, composes (a draft read inside a transaction is just a
draft-scoped tracker over the tx handle).

**One wrinkle to settle in YW-120 (not blocking):** the spike uses `FULL OUTER
JOIN` so draft-only inserts (id=4, no canonical row) survive. A `LEFT JOIN base`
would drop inserts; pure draft-side would drop unedited canonical rows. FULL
OUTER JOIN + coalesced key is the correct primitive — confirmed by the passing
test. YW-120 should lock this as the canonical lowering and decide column-set
handling when delta/base column sets drift (out of scope here).

## Seam B — coalesce view  (rank 2)

The coalesced read works (test B1: per-draft view; B2: generic view + session
GUC `current_setting('df.draft')`). But:

- **DDL lifecycle leaks into runtime.** Per-draft views (B1) mean
  `CREATE VIEW … / DROP VIEW …` on every draft open/close — DDL churn, naming
  management, teardown-on-crash hazards. A draft sandbox (YW-260) that's cheap to
  spin up/down should not be issuing DDL.
- **Generic GUC view (B2) has a real correctness hazard.** Test
  `B2 no-draft HAZARD` demonstrates: with the GUC unset, a `FULL OUTER JOIN` view
  **leaks** the draft-insert row (id=4) and **duplicates** the edited row (id=1)
  as right-only rows — a no-draft read of the view is *wrong* (`[1,1,2,3,4]`). To
  be correct no-draft the view must gate the entire draft side on the GUC being
  set, which makes the body materially more complex **and** still pays a
  join/filter on every no-draft read. Both cost dimensions worsen.
- **Not a sibling to `transaction()`** — it's a foreign concept (DDL + connection
  state), not a scoped handle.
- **"Reads unchanged" is illusory** — see zero-overhead FAIL above.

## Seam C — driver / lowering interception  (rank 3, near-infeasible cleanly)

A driver-level string rewrite *can* produce the coalesce (test rewrites
`FROM "todos"` → coalesce subquery and gets the right rows). But:

- **The driver sees opaque SQL text + params** — no table object, no column
  list, no PK info (test asserts `.toSQL()` output has no `table`/`columns`
  property). The `(draft_id, id)` coalesce key is a *DSL-level* concept; the
  driver only has text. To act on it the driver must **re-parse SQL** — brittle
  (aliases, quoting, CTEs, subqueries, the table name inside a string literal all
  break a regex). This is the "too low" finding: the layer does not natively know
  the semantics it must act on.
- **Per-read tax** (zero-overhead FAIL above).
- **Wrong layer / not a sibling** to `transaction()`.

---

## DashFrame consumer fit (the end-to-end judgment)

The real consumer is `apps/server/src/functions/app-artifacts.ts` +
`commands.ts`: ~30 reads/writes shaped `ctx.db.from(<table>).where(eq(...))
.first()/.all()`. The decisive plumbing fact:

> **`ctx.db` is injected ONCE.** In `@wystack/server` `create.ts:135`,
> `runHandler` builds `const ctx = { ...context, db: tracked }`. Per-request
> `context` already comes from `httpResolveContext(req)` (`routes.ts`), so a
> `draftId` rides in the request context *naturally*, alongside auth/tenant.

This reframes the threading question for every seam — and it's where Seam A pulls
decisively ahead:

- **Seam A — inject once, zero call-site changes.** Because draft-scoping is a
  property of the *handle*, the host can build `ctx.db = draftId ?
  app.createTracked().withDraft(draftId) : app.createTracked()` at the single
  `runHandler` seam. **None** of the ~30 `app-artifacts.ts`/`commands.ts` read
  sites change** — they keep calling `ctx.db.from(insights)…` and transparently
  read through the draft. The brief's worry ("server must thread draftId through
  to each read") is **only true for the explicit-per-call-site variant**; the
  central-injection variant is strictly better and is what YW-120 should ship.
  Call sites that must *escape* the draft (read canonical regardless) opt out
  explicitly — a rare, legible exception. This composes cleanly with: the draft
  sandbox (YW-260) — sandbox = a draftId in context; the assistant reading
  through a draft — assistant requests carry the draftId like any client; and
  `applyCommands` — `createTracked()` → `.withDraft()` before opening the batch
  transaction.

- **Seam B — context moves to the connection, doesn't vanish.** Reads keep the
  text `from(insights)` only if `insights` *is* the coalesce view — paying the
  join on every no-draft read (zero-overhead FAIL). Draft context becomes a
  per-connection GUC (`SET df.draft = …`), which is awkward under a pooled async
  server: the GUC must be set/reset around every request on a possibly-shared
  connection, and a leaked GUC = silently wrong reads for the next request. The
  "reads don't change" win is paid for in connection-state fragility — the
  complexity moves, it doesn't disappear.

- **Seam C — transparent reads, but magic + leak-prone.** DashFrame sets a draft
  context once and reads are transparent, but the context is ambient driver
  state with the same leak hazard as B, plus the SQL-parsing brittleness, plus
  no auditability (a read's draft-ness isn't visible at the call site or in the
  handle type). Worst end-to-end.

**DashFrame winner: Seam A**, on the strength of central injection — draft
support lands with one server-side change at the `ctx.db` seam and zero churn
across the existing artifact functions, while staying explicit and auditable
(the handle's type says it's draft-scoped) and zero-overhead for the
overwhelmingly common no-draft read.

---

## Concrete impl recipe for YW-120

1. **Add `withDraft(draftId: string): TrackedDb` to the `TrackedDb` interface**,
   sibling to `transaction()`. Implement as a `createTrackedDb(drizzleDb)` whose
   `from()` returns a draft-aware `SelectBuilder` carrying the `draftId`. Reads
   on a non-draft tracker are untouched (zero-overhead, separate path).
2. **Draft-aware `SelectBuilder.all()`** builds the coalesce:
   `FULL OUTER JOIN <t>__draft d ON b.id = d.id AND d.draft_id = $draftId`,
   `SELECT COALESCE(d.col, b.col) AS col` for every base column,
   `WHERE COALESCE(d.__tombstone, false) = false`. Reuse the existing
   `getTableColumns`/`getTableName` introspection. Preserve `where`/`orderBy`/
   `limit` by applying them over the coalesced relation (wrap as a subquery or
   apply to the outer select).
3. **Draftable-table registry is the app's input, not `@wystack/db`'s knowledge**
   — pass the `<t>__draft` mapping (or derive by `__draft` suffix convention) so
   the db package stays app-agnostic. A read of a table with no `__draft` sibling
   under a draft handle falls back to canonical.
4. **Writes through a draft handle** target `<t>__draft` (insert/update = upsert
   delta row; delete = tombstone insert). Out of scope for *this* read spike but
   the handle is the natural home — keep it in YW-120's design.
5. **DashFrame wiring (one seam):** in the host's `runHandler`/ctx construction,
   `ctx.db = ctx.draftId ? base.withDraft(ctx.draftId) : base`. No artifact-
   function changes. `draftId` resolved in `httpResolveContext` like auth/tenant.
6. **Tombstone + insert correctness** is locked by FULL OUTER JOIN + coalesced
   key (proven). Add the YW-120 test mirroring the spike's three cases
   (edit/tombstone/insert) against the real builder.

## Open fork for the owner (do NOT decide here)

**Delta/base column-set drift.** The spike assumes `<t>__draft` carries exactly
the base columns. When the base schema evolves and a draft predates it (or a
draft adds a column), the `COALESCE(d.col, b.col)` set must be reconciled. Two
shapes: (a) draft tables are regenerated/migrated in lockstep with base (simpler
read, migration cost); (b) read tolerates column drift (coalesce only the
intersection, default the rest). This is a YW-120/YW-260 design call with a real
trade-off (migration discipline vs. read complexity) — flagging, not deciding.

---

## What ran

- `bun test src/__tests__/spike-coalesce-seam.test.ts` → **9 pass / 0 fail** (in
  the `@wystack/db` package, real PGlite).
- `bun test src` (full `@wystack/db` suite) → **68 pass / 0 fail** (spike
  coexists, nothing regressed).
- `bun run typecheck` (`tsc --noEmit`) → **clean**.
- Lowered-SQL evidence captured via real drizzle `.toSQL()`.
