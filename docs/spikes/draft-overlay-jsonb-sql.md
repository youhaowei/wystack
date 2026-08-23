# Draft overlay spike B: central JSONB changes with SQL evaluation

Status: throwaway contender, not a production decision or migration recommendation.

## Question

Can one central, sparse JSONB change table keep draft inspection and rebuild simple while preserving the existing `withDraft()` query-builder semantics in PostgreSQL?

## Shape

`wystack_draft_row_changes` has one row per `(draft, table, tenant, row)`:

```text
draft_id, table_key, tenant_key_text, tenant_key,
row_key_text, row_key, operation,
base_exists, base_revision, fields
```

- `table_key` is schema-qualified, so `app.accounts` and `audit.accounts` cannot collide.
- `row_key` and `tenant_key` are typed envelopes such as `{type:"integer",value:3}`. Their compact text forms are part of the composite primary key. JSONB stays inspectable; text avoids relying on a JSONB btree operator class.
- `operation` is `insert`, `update`, or `delete`.
- `fields` is sparse. An entry is `{original, value}`. The first upsert captures `original` from the row-locked canonical row; later edits replace only `value`.
- `undefined` is removed before storage. Plain `null` is `{kind:"sql-null"}`. `draftJsonNull()` is `{kind:"json",value:null}`. Untouched properties are absent.
- `baseRevision` captures a canonical column whose SQL name is literally `revision`; it is null when a table exposes no generic row revision. Field-level originals remain available for three-way conflict classification.

The generated SQL casts only the small JSONB side back to the canonical column/PK types. Effective filters, ordering, null behavior, and limits remain database-native. PK equality receives a special pushdown into both relations.

The command log remains publish authority. The central rows are a derived read/index artifact. `append` writes the overlay, compacted command log, touched-table metadata, and CAS revision in the same transaction. `publish` still replays the ordered command log, then removes derived changes in the same transaction. `rebuild()` row-locks the draft, deletes its derived rows, and replays the persisted log back through `withDraft()`.

Authorization stays above the raw storage relation. The lifecycle checks tenant and stable owner custody for append, rebuild, publish, discard, conflict detection, and log access before handing a trusted tenant-scoped DB handle to the overlay. Direct `withDraft()` is therefore an internal trusted primitive, not an authorization API.

## Correctness evidence

Commands run from repository root unless noted:

```sh
bun test packages/db/src/__tests__/draft-jsonb-sql-spike.test.ts
# 6 pass, 0 fail, 21 assertions

bun test packages/server/src/__tests__/draft-lifecycle.test.ts
# 39 pass, 0 fail, 95 assertions

bun run build
# 14/14 package builds
```

The focused DB suite covers:

- explicit SQL null, omitted undefined, and explicit JSON null;
- A → B → C edits retaining A as immutable original;
- draft inserts/deletes without canonical mutation;
- rows entering/leaving effective filters and ordered limited prefixes;
- same-named tables in different schemas;
- typed tenant isolation, indexed whole-draft enumeration, and a fresh tracker reading persisted state;
- PK lowering on both the canonical and central keys.

The lifecycle suite covers owner/tenant authorization, restart, row locks/CAS, command-log publish authority, atomic publish/discard, invalidation, conflict-cell enumeration, and same-named schemas. The added rebuild test deletes derived rows, verifies the overlay disappears, rebuilds from the command log, and verifies the overlay returns without altering the log.

The pre-spike DB suite is not a clean compatibility result: `bun test packages/db/src` reports 142 pass and 76 fail. Those failures are concentrated in fixtures/assertions that create or inspect the old `<table>__draft` typed relations and in old SQL snapshots. This spike deliberately did not mechanically port the typed-contender test corpus; a selected architecture would need that migration before it could claim the normal gate.

## PGlite probe

Command:

```sh
bun run packages/db/scripts/draft-jsonb-sql-benchmark.ts
```

PGlite 0.3.16, warm-query means; these are comparison probes, not production latency claims:

| Canonical N | Changed M | write/change | PK lookup | filtered order+limit | whole draft |
| ----------: | --------: | -----------: | --------: | -------------------: | ----------: |
|         100 |         1 |     6.420 ms |  0.647 ms |             0.752 ms |    0.378 ms |
|         100 |        10 |     2.085 ms |  0.346 ms |             0.487 ms |    0.333 ms |
|      10,000 |         1 |     2.640 ms |  0.338 ms |             2.665 ms |    0.330 ms |
|      10,000 |        10 |     1.461 ms |  0.329 ms |             2.473 ms |    0.323 ms |

PGlite reported a 32 KiB minimum relation footprint for every M, so its bytes/change result is a storage-allocation floor, not useful per-row amplification evidence.

## PostgreSQL 15.18 plans

The local PostgreSQL probe used 100,000 canonical rows, a `(score DESC, id)` index, 10 target changes, and 10,000 changes belonging to other drafts. It ran direct SQL equivalent to the builder lowering under `EXPLAIN (ANALYZE, BUFFERS)`. The isolated schema was removed afterward.

### PK lookup

Execution: **0.149 ms**, six shared-buffer hits.

- central side: `Index Scan using draft_changes_pkey`, exact four-column identity;
- canonical side: `Index Scan using benchmark_rows_pkey`, `id = 5`;
- the JSONB-to-integer cast occurs only after the indexed central row is found.

Conclusion: the PK special case preserves both indexes.

### Whole-draft enumeration

Execution: **0.047 ms**, four shared-buffer hits.

- `Index Scan using draft_changes_pkey` with `Index Cond: draft_id = 'target'`;
- ten rows returned in table/tenant/row-key order without a separate sort.

Conclusion: one indexed draft scan is a real benefit of the central shape.

### Effective filter + order + limit

Execution: **27.277 ms**, 644 shared-buffer hits.

- central side still used its primary-key index and read only ten changes;
- canonical side performed a sequential scan of all 100,000 rows;
- the full join evaluated the effective score for every row;
- PostgreSQL then used a top-N heapsort for the 20-row result.

Conclusion: generic SQL parity is correct, but the CASE/FULL-JOIN effective value prevents PostgreSQL from using the canonical `(score DESC, id)` index. Casting only the small side does not rescue an index whose ordering can be changed by any draft row. This is the contender's principal scaling cost.

### Storage

For 10,010 central changes with one integer field:

- total: 4,472 KiB;
- heap: 2,976 KiB;
- indexes: 1,456 KiB;
- approximately 457 bytes/change including the relation index at this sample.

Successive edits rewrite one row's JSONB `fields` document, but do not add history rows. Wider rows increase JSONB rewrite cost; untouched fields consume no storage.

## Tradeoffs and limits

Advantages:

- one query answers “everything in this draft” across every table;
- one generic migration and one generic rebuild/sweep path;
- immutable originals and typed keys are available without joining table-specific shadows;
- sparse fields make explicit null and omission unambiguous;
- point reads retain both canonical and central indexes.

Costs:

- generic effective `filter/order/limit` queries can lose canonical indexes and scan the full base table even when changes are tiny;
- every supported SQL type needs a trustworthy JSONB decode/cast expression; this spike covers current WyStack scalar, JSONB, timestamp, UUID, and array shapes but does not claim extension/custom-type support;
- `draftJsonNull()` adds an explicit API sentinel because JavaScript `null` is already the SQL NULL contract;
- the central table is an attractive cross-tenant inspection surface and must never be exposed without lifecycle authorization;
- direct DB-level concurrent writes do not acquire the persisted draft metadata lock. The server lifecycle does, so production use must keep derived writes inside append/rebuild transactions;
- base revision discovery by a column literally named `revision` is only a convention. A selected design should make the row-revision capability explicit if CAS is expected at this layer;
- generated DDL and migration v2 coexist for the spike. A selected design should choose one migration owner and provide an upgrade/backfill story from typed shadows rather than dual-write them.

## Decision implication

This is a strong shape for inspection, rebuild, conflict inputs, point lookups, and small-to-moderate effective datasets. It is not a free replacement for typed SQL shadows when draft reads commonly perform selective ordered queries over large canonical tables. If this contender is selected, the next design question is an explicit query policy: accept full effective scans, add query-specific materialization/indexes, or introduce a bounded hybrid planner rather than pretending generic index parity exists.
