# WyStack

Internal shared infrastructure — substrate, not a framework. It backs exactly two
consumer applications, DashFrame and workhub, which vendor it as a git submodule.
Nothing in this repo is published to npm, so there are no external users and no
compatibility obligation before 1.0: change signatures outright and update the two
consumers rather than adding shims or deprecation paths.

(`@wystack/ui`, `@wystack/icons`, and `@wystack/agent` are published packages, but
they are built and released from the separate stdui and unifai repos and merely
share the `@wystack` npm scope. No package in this repo ships to a registry.)

## Architecture

```
@wystack/db  <--  @wystack/server  <--  @wystack/client
(detection)       (distribution)        (consumption)
```

- `@wystack/db` -- Schema (Drizzle), SQL-agnostic drivers, read/write tracking
- `@wystack/server` -- Function registry, reactive engine, transports (WS/REST)
- `@wystack/client` -- Typed function refs, Convex-style hooks (useQuery/useMutation), TanStack Query, WS reactivity
- `@wystack/transport` -- Transport substrate: per-connection `Pipe` interface + in-memory loopback adapter + typed wire-protocol contract (shared by server and client)
- `@wystack/identity` -- Provider-neutral identity, session, and principal contracts
- `@wystack/identity-workos` -- WorkOS access-token adapter for the identity seam
- `@wystack/log` -- Structured logging (pino, wide events, ring buffer)
- `@wystack/types` -- Branded primitive types
- `@wystack/version` -- Semver utilities

## Stack

- **Runtime**: Bun
- **ORM**: Drizzle (SQL-agnostic)
- **Local dev DB**: PGlite (in-process Postgres)
- **Server**: Hono
- **Client**: React 19, TanStack Query, TanStack DB
- **Monorepo**: Bun workspaces + Turborepo
- **Tooling**: oxlint, oxfmt, changesets

## Related repos

- **stdui** -- `@wystack/ui`, `@wystack/icons` (design system, published to npm)
- **unifai** -- `@wystack/agent` (multi-provider agent abstraction, published to npm)

## Dialect policy (`@wystack/db`)

Dialect-flexible by construction — each SQL dialect lives at its own boundary.

- **Root** (`@wystack/db`) — dialect-agnostic: `defineSchema`, `createDb`, tracked queries, the schema DSL (`text`, `int`, `uuid`, `timestamp`, `jsonb`, `boolean`), operators (`eq`, `ne`, `gt`, …). This is the primary surface.
- **Subpaths** — escape hatch for dialect-specific primitives not yet in the DSL (e.g. `bytea`, composite uniques, custom types):
  - `@wystack/db/pg` (Postgres + PGlite) — today
  - `@wystack/db/mysql`, `/sqlite`, `/mssql` — land as needed

Consumer packages MUST NOT import from `drizzle-orm` directly. Route through `@wystack/db` (DSL) or the matching subpath (dialect-specific). When a new dialect lands, add its subpath file; never mix dialects at the root.

## Commands

```bash
bun install          # install all workspace deps
bun run build        # build all packages (turbo)
bun run typecheck    # typecheck all packages (turbo)
bun run test         # test all packages (turbo)
bun run lint         # lint (oxlint)
bun run format       # format (oxfmt)
bun run check        # lint + format check + typecheck + test
```

## Design

Design docs live in the [Notion Wiki](https://www.notion.so/2ffd48ccaf5480188a18c0600118e9b6). DESIGN.md was retired.

| Package | PRD | Spec |
|---------|-----|------|
| WyStack (framework) | [PRD](https://www.notion.so/33bd48ccaf54811db8d6cf1efe5b591f) | — |
| @wystack/db | [PRD](https://www.notion.so/33bd48ccaf54815c97dadbbdce0d3216) | [Spec](https://www.notion.so/33bd48ccaf5481d2a168c322e9ab1449) |
| @wystack/server | [PRD](https://www.notion.so/33bd48ccaf5481389a78eeaf0ad36c42) | [Spec](https://www.notion.so/33bd48ccaf54810fbfeccb09a5585eaa) |
| @wystack/client | [PRD](https://www.notion.so/33bd48ccaf5481b2a216d9b6ac943c03) | [Spec](https://www.notion.so/33bd48ccaf54812fbd72dffd24166b56) |
