# Draft overlay follow-up: central JSONB with bounded SQL evaluation

Status: throwaway feasibility spike. It tests one query-planning decision on top
of spike B; it does not resolve spike B's lifecycle and storage findings and is
not a production branch.

## Question

Can the central sparse-JSONB model retain PostgreSQL-native semantics without
paying for a full canonical scan on selective `filter + order + limit` reads?
The additional constraint is maintainability: the optimizer must stay local to
one lowering seam and must not reproduce PostgreSQL comparison behavior in
JavaScript.

## Result

Yes, for WyStack's current single-table query surface. The bounded plan is
exact for the supported filters, one ordering column with a primary-key
tiebreak, and an optional limit. PostgreSQL 15 used both the canonical ordering
index and canonical primary key; the 100,000-row probe fell from 15.128 ms for
the generic full-effective plan to 0.195 ms for the bounded plan.

The SQL is moderately more complex, but contained. The builder adds three
named stages:

1. `draft_delta`: the M changes for exactly one draft/table/tenant.
2. `base_top`: the first `L + M` canonical rows under the base filter and
   ordering. Without a limit, it contains every canonical base match.
3. `candidate_base`: unchanged base candidates plus canonical rows addressed
   by every changed identity.

The final join reuses the generic plan's effective expressions, filter,
ordering, and limit. PostgreSQL therefore remains the only engine deciding SQL
NULL behavior, text collation, timestamps, JSONB comparisons, and tie order.
The generated representative query is 1,710 bytes with seven bound parameters;
the new planner is 76 source lines in one method. Production code should extract
the candidate CTE construction into one helper, but it does not require a
second evaluator or per-table SQL templates.

## Why the `L + M` bound is exact

Let L be the requested result size and M be the number of changed identities in
the draft for this table and tenant. Only those M identities can enter, leave,
move within, or disappear from the canonical ordering. Consequently, at most M
canonical rows ahead of an unchanged row can be displaced. An unchanged row
below canonical position `L + M` cannot reach the effective top L.

The candidate relation must also include every changed identity. That covers:

- a canonical row that failed the base filter but enters after its draft edit;
- a canonical row selected by `base_top` that leaves, moves, or is deleted;
- a draft-only insert, supplied by the final full join;
- a changed row below `L + M` that moves into the effective prefix.

The proof does not cover offsets, joins, aggregation, window functions, or
multiple independent ordering terms. Those features require a separate bound
or the generic fallback before they enter WyStack's query surface.

## Correctness evidence

The test uses an independently materialized canonical twin as the oracle. It
applies the draft's mutations directly to that twin and compares the normal
canonical builder with the bounded draft builder; it does not reuse the draft
materializer as its reference implementation.

```sh
cd packages/db
bun test src/__tests__/draft-jsonb-bounded-sql-spike.test.ts \
  src/__tests__/draft-jsonb-sql-spike.test.ts
# 13 pass, 0 fail, 48 assertions

bun run typecheck
# pass
```

The bounded suite covers all six supported comparison operators, ascending and
descending order, rows entering/leaving/moving/deleting, draft-only inserts,
several limits, `first()`, `limit(0)`, projections, text ordering, and nullable
ordering. A shared draft ID across two tenants verifies that both canonical
candidates and central changes remain tenant-scoped. The suite also asserts the
lowered CTE shape. Filtered reads without a limit use all canonical matches plus
all changed keys. Unfiltered, unlimited reads retain the generic full-effective
plan because no finite bound exists. Primary key equality retains spike B's
tighter two-sided index pushdown.

## PostgreSQL 15.18 plan comparison

The probe uses 100,000 canonical rows, an index on `(score DESC, id)`, ten
target changes, and 10,000 changes belonging to other drafts. Both statements
evaluate the same `score >= 50000 ORDER BY score DESC, id LIMIT 20` request.

| Plan                       | Canonical work                                   | Target changes | Execution |
| -------------------------- | ------------------------------------------------ | -------------: | --------: |
| Generic effective relation | sequential scan of 100,000 rows                  |             10 | 15.128 ms |
| Bounded SQL candidates     | ordered index scan for 30 rows plus 10 PK probes |             10 |  0.195 ms |

The bounded plan used the central composite primary key, the canonical ordering
index, and the canonical primary key. Its final effective filter and sort saw
about 31 candidates rather than the whole table. This is about 77x faster in
this exact local probe; it is plan-shape evidence, not a production latency
claim.

Run it with:

```sh
psql -d postgres -v ON_ERROR_STOP=1 \
  -f packages/db/scripts/draft-jsonb-bounded-sql-explain.sql
```

## PGlite scaling probe

PGlite 0.3.16 warm-query means for the bounded `filter + order + limit` path:

| Canonical N | Changed M | bounded read |
| ----------: | --------: | -----------: |
|         100 |         1 |     1.049 ms |
|         100 |        10 |     0.602 ms |
|      10,000 |         1 |     0.693 ms |
|      10,000 |        10 |     0.548 ms |
|     100,000 |         1 |     0.542 ms |
|     100,000 |        10 |     0.609 ms |

The original generic spike measured 2.665 ms and 2.473 ms at N=10,000 for
M=1 and M=10. The bounded CTE has small absolute overhead at N=100, then stays
roughly flat through N=100,000. This supports using one deterministic plan
instead of adding an adaptive JavaScript threshold now.

## Maintainability assessment

The approach is manageable if the boundary stays explicit:

- one central change relation, not per-table shadow DDL;
- one candidate-planning helper, not type-specific planners;
- one set of effective expressions shared by bounded and generic plans;
- PostgreSQL performs every semantic comparison;
- unsupported future query shapes fall back until they have their own proof;
- independent materialized-oracle tests remain mandatory.

The main ongoing cost is verbose generated SQL and duplicated filter parameters
between base candidate selection and final effective validation. The
duplication is intentional: the base predicate enables index selection, while
the effective predicate proves correctness after applying draft changes.

## Inherited blockers

This spike changes only query planning. A production implementation still has
to resolve the central-storage review findings from spike B:

- rebuild currently recreates original evidence against the current canonical
  state instead of preserving or explicitly rebasing it;
- raw `changes()` inspection must not bypass lifecycle tenant/owner custody;
- sparse inserts and delete-then-create must materialize canonical default and
  replacement semantics;
- row identity needs database-canonical encoding or an explicitly restricted
  scalar key contract rather than `JSON.stringify` identity;
- lifecycle tests must stop asserting obsolete typed-shadow relations.

## Decision implication

The performance objection to central JSONB is addressable without moving SQL
semantics into JavaScript. The production direction can therefore be central
sparse JSONB storage plus bounded SQL candidate planning, with a generic SQL
fallback. Acceptance should remain conditional on resolving the five inherited
correctness and authorization blockers above and extracting the CTE lowering
into a reviewable helper.
