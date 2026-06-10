# YW-153 Spike: Deferred Literal Operand — Findings

**Date**: 2026-06-10
**Spike code**: `packages/db/src/__tests__/spike/deferred-literal.test.ts`
**Run**: `cd packages/db && bun test src/__tests__/spike/deferred-literal.test.ts`
**All 16 tests pass. Results are empirical, not theoretical.**

---

## 1. Does the operand shape survive all six stages?

**Yes, with one critical caveat at Stage 4 (Preview).** Summary by stage:

| Stage | Outcome |
|---|---|
| 1 — Agent emits | OK. Shape constructs without friction. |
| 2 — Validation | OK with caveat: validation is shape-only; unknown handles pass silently. |
| 3 — Draft stores (JSONB) | OK. Handle string round-trips perfectly through JSONB — no data loss. |
| 4 — Preview renders | **BROKEN** for unbound operand. Three options, all bad (see below). |
| 5 — User binds | OK. Throws clearly on unknown handle — correct gating. |
| 6 — SQL executes | OK. Bound command runs correctly. |

The shape survives everywhere except the preview stage, which has no good option given the current spec.

---

## 2. What does preview render for an unbound deferred operand?

This is the question the spec leaves open. The spike tested three concrete strategies:

### Option A: skip-predicate (drop the filter)

SQL emitted: `SELECT * FROM sales`

The preview executes and returns all rows. The chart **silently renders unfiltered data**. The preview looks correct at a glance — a bar chart appears with data — but it is lying: the filter the author authored is not applied. There is nothing in the rendered chart that signals a deferred predicate is pending. This is the most dangerous option: it makes a flawed artifact look like a working one.

### Option B: placeholder-sql (sentinel literal in WHERE)

SQL emitted: `SELECT * FROM sales WHERE region = '__DEFERRED__'`

The query executes without error but returns **zero rows** because no real data has that sentinel value. The chart renders as "no data". This is worse than skip-predicate: the author cannot tell if their filter logic is wrong (no matching rows genuinely) or if the operand is just unbound. It produces silent wrong output and provides no diagnostic path.

### Option C: error (block preview entirely)

SQL emitted: `-- preview blocked: unbound deferred operand`

The preview layer **refuses to execute** and surfaces an error message:
> "Cannot render preview: filter on 'region' has unbound deferred operand (categoryRef handle not yet resolved). Bind the operand or skip the filter to preview."

This is the only option that is both honest and actionable. The author sees no chart, but they know exactly why and what to do.

**There is a fourth path the spec doesn't describe**: if the preview viewer's *own* context can resolve the handle (e.g. the human previewing is in the `us-west` org and that org is the real value behind `h_xyz`), the preview resolves and executes correctly — Stage 4b in the spike. This is the ideal case but requires the preview stage to have access to a handle registry populated from the current viewer's security context.

### Recommendation: ERROR (Option C) with context-resolution escape hatch

Block preview with a clear error when the handle is unbound AND no viewer context is available to resolve it. If the preview renderer has access to a registry (e.g. the viewer's category memberships), resolve there first and short-circuit to a normal query. The error is never silent: it names the field, the handle, and the required action.

Rationale:
- Skip-predicate causes authors to ship artifacts they believe are filtered but are not. That is a privacy violation risk, not just a UX bug.
- Placeholder-sql produces a chart that looks like a data gap, not an authoring problem — wrong mental model for the author.
- Error is the only option that is honest and preserves the invariant: **an unbound handle must not produce a result that looks like a bound one**.

---

## 3. Frozen-API regret risk

Two structural issues in the `value | deferred` union as currently specced. Both warrant fixing before YW-106 ships.

### Issue A: The `ref` sub-union is not a tagged union

The current spec models the deferred ref as a property-presence union:
```
ref: { columnRef: string } | { categoryRef: string } | { prompt: string }
```

This requires consumers to use `'columnRef' in ref`, `'categoryRef' in ref`, etc. to narrow. TypeScript handles this fine in type-checked code. The problem is at the JSON boundary: any code that receives this from a JSONB column, a wire message, or a foreign caller must reconstruct the union by key-presence checks rather than reading a discriminant field. That is fragile and non-extensible.

If a fourth ref type is added later (e.g. `{ expressionRef }` for computed operands), existing key-presence guards will silently fall through to the "unknown" branch rather than producing a compile-time error from exhaustive checking.

**Concrete risk**: A missing `default:` in a switch/if-chain over the ref union will compile without warning. A tagged union would make the omission a TypeScript error at the call site.

### Issue B: `v: null` in value operands is semantically valid but syntactically ambiguous

The spec does not state whether `v: null` is a valid IS-NULL filter or an absent/missing value. Consumers checking truthiness (`if (operand.v)`) will reject null as "no value" when it is a deliberate filter for rows where the column IS NULL.

The spike confirms `{ kind: "value", v: null }` passes validation when checked with `'v' in operand` — but this guard is subtle and easy to get wrong. The spec must explicitly state: **`null` is a permitted `v` and means the filter tests for NULL (IS NULL / IS NOT NULL semantics depending on `op`).**

### Issue C: Validation cannot detect unknown handles

Validation can only check that the `categoryRef` string is non-empty. It cannot verify the handle exists in the privacy gate's registry — the gate is not reachable at command-parse time. This is architecturally correct (keep validation stateless) but means **invalid handles pass validation and only blow up at bind time (Stage 5) or at preview time if the resolver returns null**. The command vocabulary must document that handle existence is NOT a validation-time guarantee.

---

## 4. Concrete recommendation for YW-106

**Change the `ref` sub-union to a tagged union before the command vocabulary freezes.**

Replace:
```typescript
ref:
  | { columnRef: string }
  | { categoryRef: string }
  | { prompt: string }
```

With:
```typescript
ref:
  | { type: 'column';   fieldId: string }
  | { type: 'category'; handle: string  }
  | { type: 'prompt';   text: string    }
```

This costs nothing at this stage (one rename on a shape that exists only in a spec) but gains:
- Exhaustive switch narrowing with TypeScript compile-time safety.
- A stable discriminant for JSON deserialization without key-presence guessing.
- A clear extension point: adding a fourth ref type adds a new variant, not a new property name.

**Also add to the spec**:
1. `v: null` on a `ValueOperand` is valid and means IS NULL. State this explicitly.
2. `categoryRef` handle existence is NOT a validation contract. It is a bind-time contract. Document the error mode.
3. Preview behavior for unbound `categoryRef` is: **block with error**, unless the preview renderer has a viewer-scoped registry to resolve from. The preview layer must declare which registry scope it uses (authoring-time, viewer-time, none).

---

## Summary judgment: safe to freeze?

**Not yet.** The `value | deferred` top-level union is fine. The three-way `ref` property-presence union is a regret trap: it works today but will become a maintenance burden the moment a fourth ref type is needed, and it produces non-obvious bugs at JSON boundaries. The fix is a one-line type change with zero runtime cost.

The preview gap (finding 2) is a design decision, not a shape defect — but the spec must make it explicit. Right now the spec is silent on what a preview chart renders for an unbound handle. That silence will produce inconsistent implementations.

Fix the tagged-union shape and document the preview contract before YW-106 ships.
