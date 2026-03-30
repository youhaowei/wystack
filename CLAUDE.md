# WyStack

Full-stack reactive data framework built on open standards.
"Convex-level reactivity, your own Postgres, deploy anywhere."

## Architecture

Three core packages with a clean dependency chain:

```
@wystack/db  ←──  @wystack/server  ←──  @wystack/client
(detection)       (distribution)        (consumption)
```

- `@wystack/db` — Schema (Drizzle), SQL-agnostic drivers, read/write tracking
- `@wystack/server` — Function registry, reactive engine, transports (WS/REST)
- `@wystack/client` — React hooks, TanStack DB (local cache), sync engine

## Stack

- **Runtime**: Bun
- **ORM**: Drizzle (SQL-agnostic — Postgres, MySQL, SQLite, MSSQL)
- **Local dev DB**: PGlite (in-process Postgres)
- **Server**: Hono (lightweight, runs everywhere)
- **Client state**: TanStack DB + TanStack Query
- **Monorepo**: Bun workspaces

## Commands

```bash
bun install          # install all workspace deps
bun run build        # build all packages
bun run typecheck    # typecheck all packages
bun run test         # test all packages
```