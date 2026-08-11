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
