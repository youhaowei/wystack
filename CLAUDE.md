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
- `@wystack/client` -- Typed function refs, Convex-style hooks (useQuery/useMutation), TanStack Query, WS reactivity
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

Design docs live in the [Notion Wiki](https://www.notion.so/2ffd48ccaf5480188a18c0600118e9b6). DESIGN.md was retired.

| Package | PRD | Spec |
|---------|-----|------|
| WyStack (framework) | [PRD](https://www.notion.so/33bd48ccaf54811db8d6cf1efe5b591f) | — |
| @wystack/db | [PRD](https://www.notion.so/33bd48ccaf54815c97dadbbdce0d3216) | [Spec](https://www.notion.so/33bd48ccaf5481d2a168c322e9ab1449) |
| @wystack/server | [PRD](https://www.notion.so/33bd48ccaf5481389a78eeaf0ad36c42) | [Spec](https://www.notion.so/33bd48ccaf54810fbfeccb09a5585eaa) |
| @wystack/client | [PRD](https://www.notion.so/33bd48ccaf5481b2a216d9b6ac943c03) | [Spec](https://www.notion.so/33bd48ccaf54812fbd72dffd24166b56) |
