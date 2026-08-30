# WyStack

Full-stack reactive data framework built on open standards.

> Convex-level reactivity, your own Postgres, deploy anywhere.

## Packages

| Package | Description |
|---------|-------------|
| `@wystack/db` | Schema (Drizzle), SQL-agnostic drivers, read/write tracking |
| `@wystack/server` | Function registry, reactive engine, transports (WS/REST) |
| `@wystack/client` | React hooks, TanStack DB, sync engine |
| `@wystack/log` | Structured logging (pino, wide events, ring buffer) |
| `@wystack/types` | Branded primitive types |
| `@wystack/version` | Semver utilities |

## Related repos

- [stdui](https://github.com/youhaowei/stdui) -- `@wystack/ui`, `@wystack/icons` (design system)
- [unifai](https://github.com/youhaowei/unifai) -- `@wystack/agent` (multi-provider agent abstraction)

## Getting started

```bash
bun install        # install all workspace deps
bun run build      # build all packages
bun run typecheck  # typecheck all packages
bun run test       # test all packages
bun run lint       # lint (oxlint)
bun run format     # format (oxfmt)
bun run check      # lint + format + typecheck + test
```

## Architecture

```text
@wystack/db  <--  @wystack/server  <--  @wystack/client
(detection)       (distribution)        (consumption)
```

See [DESIGN.md](./DESIGN.md) for the full framework design.

## Schema bootstrap and migration

`syncSchema(db, schema)` creates missing development tables. It deliberately
does not alter existing tables. Applications upgrading a database bootstrapped
by WyStack before tenant-qualified primary keys must run the explicit contract
migration once, with a migration-capable role, before serving the new version:

```ts
import { migrateTenantPrimaryKeys, syncSchema } from '@wystack/db'

await syncSchema(db, schema)
await migrateTenantPrimaryKeys(db, schema)
```

The migration accepts only the known expand shape: a global logical primary key
plus a unique `(tenant, logical ID)` index. It is atomic and idempotent. It keeps
the tenant-qualified unique index so existing composite foreign keys remain
valid, and fails with the exact blocker when a foreign key still references only
the old global ID. Before migrating a legacy table or accepting a composite key
as current, it preflights every ready/live unique index that can still enforce
writes, even when the planner marks that index invalid. It rejects direct keys
made only of logical-ID slots and follows catalog dependencies through partial,
expression, `INCLUDE`, whole-row, and generated-column shapes. Derived or
ambiguous identity is accepted only when the tenant column is a direct key
attribute; encoded tenant expressions do not qualify. Indexes that never became
ready are ignored because they do not enforce writes.

This is a structural PostgreSQL-catalog guarantee, not semantic proof over
arbitrary triggers or custom runtime behavior. PostgreSQL dependency rows do not
fully separate key expressions from predicates, so the migration deliberately
fails closed on ambiguous catalog shapes and reports the exact blocking object.
Use an explicit tenant key or remove the blocker intentionally. `adoptSchema`
may explicitly represent the pre-contract `global-primary-compatibility` shape,
but the schema passed to this migration must declare the target composite
primary key; the migration rejects compatibility metadata so application
metadata cannot keep claiming the retired shape. All other schema evolution
remains application-owned.

This helper is an offline contract migration. For each planned table, the
regular `ADD ... PRIMARY KEY` takes an `ACCESS EXCLUSIVE` lock and scans the
table to build a new unique B-tree index. The retained expand-phase
`(tenant, logical ID)` index is normally owned by its `UNIQUE` constraint and is
not reused. Each lock remains held from that table's `ALTER TABLE` until the
outer transaction commits, so earlier tables stay locked while later tables
migrate. Run the helper on a dedicated migration connection with appropriate
nonzero `lock_timeout` and `statement_timeout` settings; when both are set, keep
`lock_timeout` lower. For a shorter blocking window on large tables, use an
application-owned migration that builds a separate eligible unique B-tree index
with `CREATE UNIQUE INDEX CONCURRENTLY` outside the transaction, then attaches
it with `ADD CONSTRAINT ... PRIMARY KEY USING INDEX`. This shortens but does not
remove the exclusive-lock window; the helper does not implement that path.

## Server functions

WyStack exposes a Query and two one-shot function kinds:

- **Query** — reads data and may be called once or subscribed to reactively.
- **Action** — performs one-shot, non-reactive external I/O or orchestration.
- **Mutation** — the database-write specialization: eligible for transactional command/draft
  workflows and drives invalidation from committed tracked writes.

Define an Action with
  `wy.procedure.input({...}).action(handler)` and invoke it with `client.action(ref, args)` or
  `useAction(ref)`. Actions are never subscribable and retain an explicit `action` kind on HTTP,
  WebSocket, loopback, and Electron IPC carriers.

HTTP callers may pass an `AbortSignal` to `client.action`. This aborts the client request, but
WyStack does not yet promise server-handler cancellation: message transports need a cancel frame
and dispatch-owned `AbortController` lifecycle before that guarantee can be made.
