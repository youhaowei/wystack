# WyStack

Full-stack reactive data framework built on open standards.
"Convex-level reactivity, your own Postgres, deploy anywhere."

## Architecture

```
@wystack/db  <--  @wystack/server  <--  @wystack/client
(detection)       (distribution)        (consumption)
```

- `@wystack/db` -- Schema (Drizzle), SQL-agnostic drivers, read/write tracking
- `@wystack/server` -- Function registry, reactive engine, transports (WS/REST)
- `@wystack/client` -- React hooks, TanStack DB (local cache), sync engine
- `@wystack/runtime` -- App bootstrap, port discovery, lifecycle
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

See [DESIGN.md](./DESIGN.md) for the full framework design.
