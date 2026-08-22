# Multitenancy and durable drafts

- Status: Accepted
- Related decision: [ADR 0001](../adr/0001-compose-table-capabilities.md)

## Goal

Add native, opt-in multitenancy and database-persisted drafts through composable
table capabilities. Canonical and draft execution must support the same query
and mutation contract. Tenant isolation must be structural and fail closed.

## Non-goals

- Define Workspace, organization, membership, invitation, billing, or product
  role semantics.
- Move application graph validation or command meaning into WyStack.
- Promise transparent tenant isolation for arbitrary `db.raw` SQL.
- Support more than one tenant dimension in one schema in the first release.

## Public model

`table(...)` defines unscoped storage. A single-tenant application needs no
tenancy configuration.

```ts
const schema = defineSchema({
  todos: table({
    id: uuid.primaryKey(),
    title: text,
  }).draftable(),
});
```

`multiTenant(...)` configures one tenant key and returns a tenancy descriptor.

```ts
const workspaceTenancy = multiTenant({
  key: {
    property: "workspaceId",
    column: "workspace_id",
    type: uuid,
  },
});

const schema = defineSchema({
  connectorCatalog: table({
    id: text.primaryKey(),
    name: text,
  }),

  insights: workspaceTenancy
    .table({
      id: uuid.primaryKey(),
      name: text,
      definition: jsonb,
      revision: integer,
    })
    .draftable(),
});
```

The injected tenant property is part of selected row types. Scoped insert and
update types omit it because WyStack supplies it from trusted context. System
migration APIs may assign it explicitly.

Every schema entry must be a table definition. Bare column objects are rejected.
`.draftable()` requires a stable primary key and generates the shadow table.
Capability order must not change the compiled schema; the internal table model
stores normalized capability metadata rather than builder call order.

## Tenant context

The host resolves an application-requested tenant selection into trusted
context. The requested value selects a candidate tenant; it does not grant
access.

```ts
const app = wy.build({
  schema,
  resolveTenant: async ({ principal, requestedTenantId }) => {
    const access = await applicationMembershipLookup(
      principal,
      requestedTenantId,
    );
    if (!access) throw new PermissionDeniedError("tenant.access");
    return access.tenantId;
  },
});
```

The application owns membership lookup. WyStack binds the returned opaque
tenant ID to the request, transaction, subscription, and draft operation.

For `tenancy.table(...)`, the scoped database handle must:

- add the tenant predicate to reads, updates, and deletes;
- populate the tenant column on inserts;
- reject a conflicting tenant value crossing an untyped boundary;
- prevent updates to the tenant column;
- preserve scope across transactions and command replay;
- fail before SQL execution when tenant context is missing.

`table(...)` is not tenant-filtered. Authorization for its reads and writes is
application policy. A tenant-scoped draft may read global tables but cannot
write a global draftable table. A global draft may write only global draftable
tables and requires privileged host context. One draft cannot mix global and
tenant-isolated writes.

Raw SQL remains an explicit escape hatch. Tenant-scoped raw access requires a
named unsafe/system capability and manual read/write tracking.

## Tenant-aware schema generation

A tenant-isolated table receives the configured tenant column physically. The
column is non-null and system-managed.

```sql
CREATE TABLE insights (
  workspace_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  name text NOT NULL,
  definition jsonb NOT NULL,
  revision integer NOT NULL,
  UNIQUE (workspace_id, id)
);
```

The declared primary key remains the table's stable row identity. WyStack adds
a tenant-prefixed unique constraint for tenant-aware foreign keys; enabling
tenancy does not silently change primary-key shape.

WyStack provides tenant-local constraint helpers:

```ts
slug: text.uniqueWithinTenant()
insightId: uuid.referencesWithinTenant("insights")
```

They lower to composite uniqueness and references containing the configured
tenant column. Cross-tenant references fail at the database boundary.

## Patch semantics

Insert and update input distinguish assignment from omission:

| Input | Meaning |
| --- | --- |
| key omitted | leave unchanged |
| key present with `undefined` | leave unchanged |
| key present with `null` | assign SQL `NULL` |
| key present with a value | assign that value |

`undefined` does not survive JSON serialization, so durable commands represent
unchanged fields by omitting their keys. Runtime update lowering also ignores
own properties whose value is `undefined`.

Nullable and optional descriptors are independent. A patchable nullable field
is both optional and nullable at the input boundary.

## Generated shadow tables

For each draftable table, WyStack generates `<table>__draft`. A tenant-isolated
shadow contains:

```text
draft_id
tenant key
canonical primary-key columns
nullable copies of mutable canonical columns
__overrides
__tombstone
```

`__overrides` is a non-null text array containing the SQL names of columns the
draft explicitly assigns. Primary-key and tenant columns are immutable and never
appear in the array.

The shadow primary key contains the draft ID, tenant key when present, and
canonical primary key. Generated indexes prefix canonical lookup indexes with
the draft ID and tenant key.

Canonical foreign keys are not copied blindly to shadows. A draft-created child
may reference a draft-created parent that does not exist canonically. Effective
graph validation and canonical publish enforce those relationships.

## Effective rows and query parity

Draft reads operate on an effective relation built from canonical and shadow
rows. Mutable values use presence-aware selection:

```sql
CASE
  WHEN 'description' = ANY(d.__overrides) THEN d.description
  ELSE b.description
END
```

`COALESCE(d.description, b.description)` is forbidden for mutable values because
it cannot distinguish explicit `NULL` from inheritance.

Canonical and draft builders share one normalized query plan containing
filters, projection, ordering, limit, and terminal operation. Canonical lowering
targets the base table; draft lowering targets the effective relation.

Both paths support every public operator, multiple filters, non-primary-key
predicates, `all()`, and `first()`. Filters, ordering, and limits apply after
effective values are resolved. Values remain bound parameters and pass through
the same column codecs. Unsupported shapes fail identically.

## Mutation parity

Draft inserts, updates, and deletes accept the same supported predicates and
return the same affected-row semantics as canonical mutations.

A draft update runs atomically:

1. Evaluate filters against the tenant-scoped effective relation.
2. Resolve every matching primary key.
3. Ignore omitted and `undefined` patch values.
4. Upsert one shadow patch per match.
5. Add every assigned column, including explicit-null columns, to
   `__overrides`.
6. Clear `__tombstone` for an updated or recreated row.
7. Return the updated effective rows.

A draft delete resolves the same target set and upserts tombstones. General
update parity without delete parity is incomplete.

This supports row compare-and-set without a revision-specific framework API:

```ts
const updated = await db
  .from(insightJoins)
  .where(eq("id", joinId))
  .where(eq("revision", expectedRevision))
  .update({ leftKey, revision: expectedRevision + 1 });

if (updated.length === 0) throw new RevisionConflictError();
```

## Durable lifecycle

Draft metadata, commands, and touched-shadow identities are database records.
The first framework migration creates:

```text
wystack_drafts
- draft_id
- tenant_scope JSONB: opaque configured tenant ID, absent for global drafts
- owner_key JSONB: stable Principal coordinates by default, or a host-resolved key
- base_version JSONB
- log_revision
- created_at
- updated_at

wystack_draft_commands
- draft_id
- position
- command JSONB
- PRIMARY KEY (draft_id, position)

wystack_draft_tables
- draft_id
- schema_name
- table_name
- pk_column
- shadow_tag
- PRIMARY KEY (draft_id, schema_name, table_name)

wystack_framework_migrations
- migration_name
- version
- applied_at
```

The durable command log is publish authority. Shadows are derived read overlays.

A draft ID is a locator, not authority. Every lifecycle operation resolves the
current tenant, compares it with persisted scope, then checks the current owner.
WyStack defaults the owner key to `{ kind, userId }` or `{ kind, credentialId }`;
it does not persist optional identity profile fields. Applications may provide
`resolveOwner` for a stable application key or `authorizeDraft` for explicit
collaboration and product roles. An authorization hook can widen owner access,
but never bypass tenant scope. Publish revalidates both before replay.

### Open

Opening a draft resolves its scope and inserts metadata. Tenant scope is
immutable for the draft's lifetime.

### Append

Append executes one batch in a database transaction:

1. Lock or compare-and-set `log_revision`.
2. Verify the draft still exists and the request matches its scope.
3. Snapshot commands before execution.
4. Execute through the scoped draft database handle.
5. Append the commands, or a replay-equivalent compaction, that produced the
   shadow state.
6. Advance `log_revision`.
7. Commit shadow and log changes together.
8. Emit draft-scoped invalidation after commit.

A failed command rolls back its whole append batch. No shadow write may exist
without a command that can reproduce it.

### Publish

Publish must:

1. Load the ordered command log and record its `log_revision`.
2. Bind or resolve late command values without mutating canonical state.
3. Begin a database transaction and lock the draft metadata row.
4. Verify the draft still exists and its `log_revision` is unchanged.
5. Revalidate current authorization through an application hook.
6. Replay the bound log against canonical storage in that transaction.
7. Enforce row CAS and canonical constraints during replay.
8. Delete shadows, commands, and metadata in the same transaction.
9. Emit canonical and shadow invalidation only after commit.

The transaction-local row lock is the publish claim. A concurrent append,
publish, or discard waits for the lock and then observes either the updated log
revision or the deleted draft. Process death rolls back the transaction and
releases the lock, so no persisted lease or recoverable `publishing` state is
needed. Any replay conflict also rolls back the transaction and leaves the
draft retryable.

### Discard and repair

Discard locks the draft metadata row, deletes shadows, commands, and metadata
in one transaction, then emits shadow invalidation. Failure rolls back and
leaves the draft retryable.

After restart, metadata and logs are authoritative. Repair may rebuild shadows
by replaying the log; it never reconstructs the log from shadows.

## Invalidation

Invalidation identity includes table scope:

```text
global table
tenant table + tenant key
draft table + draft ID + optional tenant key
```

Tenant writes do not recompute subscriptions for another tenant. Draft append
and discard emit the precise shadow identities affected by their committed
transaction. Publish emits both swept shadow identities and changed canonical
identities.

Subscription re-queries retain immutable tenant selection but do not rely on
indefinitely cached membership or role decisions. Applications provide the
authorization refresh policy.

## Migration

Implementation targets the latest WyStack `main`, not an application's pinned
submodule commit.

1. Land independent nullable and optional input semantics.
2. Introduce table builders and normalized capability metadata.
3. Generate tenant columns and enforce scoped canonical access.
4. Generate presence-aware shadows and use the shared query plan.
5. Add full draft mutation parity.
6. Add durable draft metadata and command tables.
7. Move lifecycle operations to database transactions and row-lock claims.
8. Add scope-aware invalidation.
9. Migrate consumers, then remove host-provisioned shadows and the in-memory
   lifecycle.

Changing shadow null semantics requires zero open legacy drafts. Existing `NULL`
shadow values mean inheritance, so no migration can infer an explicit-null
assignment that the old model could not represent. Consumers publish or discard
open drafts before cutover.

Each phase has one authority. WyStack does not maintain indefinite dual writes
between old and new shadow or lifecycle representations.

## Acceptance criteria

### Schema and tenant isolation

- A single-tenant schema uses `table(...)` without tenancy configuration.
- `tenancy.table(...)` injects the configured tenant property and column.
- Scoped input cannot assign or mutate the tenant property.
- `.draftable()` generates a shadow without repeating domain columns.
- Multiple tenancy descriptors and draftable tables without stable primary keys
  are rejected.
- Reads, inserts, updates, deletes, transactions, commands, and subscriptions
  cannot cross tenant scope.
- Caller-supplied tenant values cannot replace resolved context.
- Tenant-aware uniqueness and references reject cross-tenant relationships.
- A draft ID cannot reveal or mutate a draft outside the resolved tenant scope.

### Draft parity

- Omitted and `undefined` patch fields inherit canonical values.
- Explicit `null` clears a nullable value in preview and publish.
- Draft reads match canonical results for every supported filter, projection,
  order, limit, `all()`, and `first()` combination.
- Draft update and delete match canonical target selection and affected rows.
- Revision CAS matches between draft execution and canonical replay.
- Draft-only inserts, updates, tombstones, and recreate-after-delete produce the
  expected effective rows.

### Durability and concurrency

- Drafts, commands, and shadows survive process restart.
- Concurrent appends serialize through `log_revision` CAS without lost or
  reordered commands.
- Append never leaves a shadow write without its durable command.
- Publish atomically replays commands and removes all draft state.
- Failed publish and discard remain retryable.
- A stale row revision rolls back the entire publish.
- Process exit during append, publish, or discard preserves one authoritative
  state.

### Invalidation and authorization

- Tenant writes invalidate only matching tenant subscriptions.
- Draft writes invalidate only matching draft subscriptions.
- Publish and discard invalidate swept shadow readers after commit.
- Authorization is revalidated before publish.
- Persisted draft scope cannot be changed by the caller.
- Draft collaboration requires an explicit application authorization hook.
