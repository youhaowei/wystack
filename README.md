# WyStack

Full-stack reactive data framework built on open standards.

> Convex-level reactivity, your own Postgres, deploy anywhere.

## Packages

| Package | Description |
|---------|-------------|
| `@wystack/db` | Schema (Drizzle), SQL-agnostic drivers, read/write tracking |
| `@wystack/server` | Function registry, reactive engine, transports (WS/REST) |
| `@wystack/client` | React hooks, TanStack DB, sync engine |
| `@wystack/runtime` | App bootstrap, port discovery, lifecycle |
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

