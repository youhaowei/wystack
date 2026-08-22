# ADR 0001: Compose storage capabilities on table definitions

- Status: Accepted
- Date: 2026-08-21

## Context

WyStack needs native multitenancy and durable drafts. These features both alter a
table's storage and runtime behavior:

- multitenancy injects and enforces an application-named tenant key;
- drafts add a canonical-plus-shadow read model and a durable command lifecycle.

Applications should not repeat a tenant column on every table or duplicate a
table's domain columns in a separate draft-table declaration. Separate APIs for
every combination, such as `tenantTable`, `draftTable`, and
`tenantDraftTable`, would grow combinatorially as WyStack adds other storage
capabilities.

WyStack must also keep its framework terms separate from application terms.
DashFrame and WorkHub call their tenant boundary a Workspace, but WyStack should
only understand opaque tenant identity and isolation.

## Decision

WyStack will represent storage behavior as composable table capabilities.

`table(...)` defines an ordinary unscoped table. `multiTenant(...)` returns a
configured tenancy descriptor whose `.table(...)` factory defines a
tenant-isolated table. `.draftable()` composes draft behavior onto either kind
of table.

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
      revision: integer,
    })
    .draftable(),
});
```

The four initial combinations are:

| Definition | Tenant-isolated | Draftable |
| --- | --- | --- |
| `table(...)` | No | No |
| `table(...).draftable()` | No | Yes |
| `tenancy.table(...)` | Yes | No |
| `tenancy.table(...).draftable()` | Yes | Yes |

The application configures the tenant property's TypeScript name, SQL name, and
type once. WyStack injects the physical tenant column into every table created
by that descriptor. The tenant property is readable but system-managed: scoped
application inserts and updates cannot assign or change it.

Tenant isolation does not rewrite a table's declared primary key. WyStack adds
the tenant-prefixed unique constraints and foreign-key targets needed for
tenant-local relationships while preserving the table's stable row identity.

Draftable tables generate their shadow schema from the canonical definition.
Applications never declare the same domain columns twice.

WyStack owns generic isolation, query lowering, mutation lowering, transactions,
durable draft mechanics, and invalidation scope. Applications own tenant
selection meaning, membership, product roles, and domain invariants.

## Invariants

- `table(...)` always means unscoped storage, including in a schema that also
  contains tenant-isolated tables.
- `tenancy.table(...)` always requires a resolved tenant context for ordinary
  application access and fails closed when that context is absent.
- A tenant key supplied by application input is never authority. WyStack injects
  the trusted value resolved by the host.
- `.draftable()` changes storage mechanics, not domain meaning.
- Draft command logs are publish authority. Shadow rows are derived read
  overlays.
- Tenant and draft capabilities compose without a separate combined table API.
- One schema supports at most one tenancy descriptor in the first release.

## Alternatives considered

### Make every table tenant-isolated when multitenancy is enabled

This would make `table(...)` change meaning based on distant schema
configuration. Global control-plane and catalog tables would require an escape
hatch, and a table's isolation boundary would be less visible in review.

### Declare the tenant column on every table

This repeats application terminology and enforcement configuration throughout
the schema. Repetition invites drift in column names, types, indexes, insert
behavior, and draft shadows.

### Add a table factory for every capability combination

Factories such as `tenantDraftTable(...)` encode combinations rather than
capabilities. Adding revisions, auditing, or other storage mechanics would
multiply the API surface.

### Leave multitenancy and drafts to each application

Both features cross schema generation, reads, writes, transactions,
subscriptions, and invalidation. Application conventions cannot make those
paths structurally safe or guarantee parity.

## Consequences

- Table definitions carry capability metadata consumed by schema generation,
  query and mutation lowering, migrations, subscriptions, and invalidation.
- Adding a new capability does not require a new table factory for every
  existing combination.
- Reviewers can see which tables are tenant-isolated and which are global.
- Migrating an existing table to tenant isolation is an explicit schema and data
  migration, not a configuration-only change.
- WyStack must validate incompatible capabilities and reject schemas containing
  multiple tenancy descriptors until multi-dimensional tenancy is designed.
- A schema may mix global and tenant-isolated tables. Authorization for global
  writes remains explicit application policy; tenant isolation does not imply
  permission to mutate global data.
