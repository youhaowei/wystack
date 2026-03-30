# WyStack — Framework Design

**"Convex-level reactivity, your own Postgres, deploy anywhere."**

A full-stack reactive data framework built on open standards. Define schema and functions, get typed reactive hooks. Like Convex but your data lives in your own database and you own the server.

---

## Core Packages

### `@wystack/db` — The Data Layer

- **Schema definition** — Thin wrapper over Drizzle ORM
- **SQL-agnostic** — Postgres, MySQL, MSSQL (future expansion)
- **Dual-driver for dev** — PGlite (local dev) / production database
- **Migrations** — Drizzle Kit integration
- **Read-set tracking** — Tracks which tables each query touches
- **DB-level change events** — Emits "table X changed" on writes
- **CLI**: `wystack migrate`, `wystack studio`

### `@wystack/server` — The Reactive Engine

- **Function registry** — `query()` and `mutation()` definitions with typed args
- **Mutation write tracking** — Knows which tables each mutation writes to
- **Subscription registry** — Maps "client A watches query Q" relationships
- **Auto-invalidation** — When mutation writes to table X, re-runs all queries reading table X, pushes deltas to subscribed clients
- **Transport-agnostic** — WebSocket (reactive), REST API (mobile), GraphQL (future)
- **Scheduled functions** — `cron()`, after-mutation hooks, delayed execution
- **Middleware pipeline** — Auth (bring your own), logging, custom middleware
- **Depends on**: `@wystack/db`
- **CLI**: `wystack dev`, `wystack generate`

### `@wystack/client` — The UI Layer

- **React hooks** — `useQuery()`, `useMutation()` (typed from server functions)
- **TanStack DB** — Local reactive store (not PGlite — lighter, purpose-built)
- **TanStack Query** integration — Familiar patterns
- **Sync engine** — Connects to server via WebSocket, receives deltas
- **Optimistic updates** — Writes to TanStack DB instantly, reconciles on server confirm
- **Two modes**:
  - `local-first` — TanStack DB as cache, instant reads, background sync
  - `server` — Standard HTTP fetch + WebSocket invalidation (for large datasets)
- **Depends on**: `@wystack/server` (for types + connection)

---

## Architecture

```
@wystack/db          @wystack/server         @wystack/client
┌──────────┐        ┌───────────────┐        ┌─────────────┐
│ Schema   │        │ Function      │        │ useQuery()  │
│ (Drizzle)│        │ Registry      │        │ useMutation │
│          │        │               │        │             │
│ write    │──emit─→│ subscription  │──push──→│ TanStack DB │
│ tracking │        │ registry      │        │ (local      │
│          │        │               │        │  cache)     │
│ read set │──meta─→│ "who reads    │        │             │
│ tracking │        │  table X?"    │        │ React       │
│          │        │               │        │ re-renders  │
│ PGlite   │        │ Transports:   │        │             │
│ /Postgres│        │ WS/REST/GQL   │        │ Optimistic  │
│ /MySQL   │        │               │        │ updates     │
└──────────┘        └───────────────┘        └─────────────┘
  (detection)         (distribution)          (consumption)
```

> **Change detection happens at two levels:**
> 1. **DB-level** — For raw SQL, scripts, external writes (via Drizzle hooks / LISTEN/NOTIFY)
> 2. **Server-level** — For mutations going through WyStack (function registry tracks write sets)

---

## Developer Experience

### 1. Define Schema

```typescript
// wystack/schema.ts
import { defineSchema, table, text, uuid, timestamp } from '@wystack/db'

export default defineSchema({
  tasks: table({
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    orgId: uuid().notNull(),
    status: text().default('todo'),
    createdAt: timestamp().defaultNow(),
  }),
})
```

### 2. Define Server Functions

```typescript
// wystack/functions/tasks.ts
import { query, mutation } from '@wystack/server'
import { schema } from '../schema'

export const list = query(
  { args: { orgId: 'uuid' } },
  async (ctx, { orgId }) => {
    return ctx.db.select().from(schema.tasks)
      .where(eq(schema.tasks.orgId, orgId))
  }
)

export const create = mutation(
  { args: { title: 'string', orgId: 'uuid' } },
  async (ctx, { title, orgId }) => {
    return ctx.db.insert(schema.tasks)
      .values({ title, orgId }).returning()
  }
)
```

- `ctx` provides `db`, `log`, and any custom middleware injections
- Server tracks that `list` reads from `tasks` where orgId = X
- Server tracks that `create` writes to `tasks`
- When `create` runs → server re-runs `list` for affected orgIds → pushes delta

### 3. Use in React

```typescript
import { useQuery, useMutation } from '@wystack/client'
import { api } from '../wystack/_generated/api'

function TaskList({ orgId }) {
  const tasks = useQuery(api.tasks.list, { orgId })
  const createTask = useMutation(api.tasks.create)

  return (
    <ul>
      {tasks.map(t => <li key={t.id}>{t.title}</li>)}
      <button onClick={() => createTask({ title: 'New', orgId })}>
        Add
      </button>
    </ul>
  )
}
```

- `api` is auto-generated types from server functions
- `useQuery` is reactive — subscribes via WebSocket, re-renders on changes
- `useMutation` does optimistic updates via TanStack DB

### 4. Configuration

```typescript
// wystack.config.ts
import { defineConfig } from '@wystack/server'

export default defineConfig({
  db: {
    dev: 'pglite://./data/pglite',
    prod: process.env.DATABASE_URL,
  },
})
```

### 5. Dev Workflow

```bash
bun wystack dev       # starts server (PGlite) + generates types
bun wystack generate  # regenerate types from schema/functions
bun wystack migrate   # drizzle-kit migrations for prod
bun wystack studio    # drizzle studio
```

---

## Ecosystem Packages

| Package | Description | Based On |
|---------|-------------|----------|
| `@wystack/log` | Structured logging, WideEvent, pino | tracey |
| `@wystack/react-ui` | Design system, components, theme | stdui |
| `@wystack/icons` | Icon components | stdui icons |
| `@wystack/agent` | Agent tooling | — |

**Future:**
- `@wystack/api` — OpenAPI generation from function registry
- `create-wystack-app` — CLI project scaffolder
- `@wystack/swift` / `@wystack/kotlin` — Mobile clients

---

## Deployment Modes

### Embedded

WyStack mounts as middleware in your existing app:

```typescript
app.route('/wystack', wystack.handler())
```

Same process. Simplest setup.

### Standalone

WyStack runs as its own service:

```bash
bun wystack serve  # :3210
```

Multiple frontends can connect. Better for scale.

---

## Key Design Decisions

1. **SQL-agnostic** — Drizzle supports Postgres, MySQL, SQLite, MSSQL. WyStack inherits this.
2. **Transport-agnostic** — WebSocket for reactivity, REST for mobile/external, GraphQL future. All from the same function registry.
3. **Client uses TanStack DB, not PGlite** — Client needs a reactive cache, not a full database. TanStack DB is lighter and purpose-built.
4. **PGlite is server-side only** — For local development, replacing a real Postgres. Not shipped to the browser.
5. **No auth package** — Apps bring their own auth. WyStack provides middleware hooks for injection.
6. **Two client modes** — `local-first` (TanStack DB cache + sync) for most apps, `server` (HTTP + WS invalidation) for large datasets.
7. **Selective sync** — Clients subscribe to specific queries, not full tables. Server pushes only matching deltas.

---

## Implementation Phases

**Phase 1: @wystack/db**
- Extract Drizzle schema helpers
- Dual-driver setup (PGlite dev / Postgres prod)
- Migration CLI
- Read-set tracking primitives

**Phase 2: @wystack/server**
- Function registry (query/mutation)
- Type generation (auto-generate api.ts)
- HTTP transport (Hono)
- Basic mutation tracking + invalidation

**Phase 3: @wystack/client**
- React hooks (useQuery/useMutation)
- TanStack Query integration
- WebSocket connection to server

**Phase 4: Reactivity**
- WebSocket subscriptions
- Server-side subscription registry
- Delta push on mutations
- Optimistic updates via TanStack DB

**Phase 5: Ecosystem**
- @wystack/log (structured logging)
- @wystack/react-ui (design system)
- REST transport
- create-wystack-app CLI
