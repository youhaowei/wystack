// @wystack/db/pg
// Postgres-dialect primitives: pg-core columns, table builder, constraint
// helpers, and the PGlite driver. Consumers that want Postgres + PGlite
// today import from here explicitly — keeps the dialect choice legible at
// the call site and makes it trivial to add `@wystack/db/mysql`,
// `@wystack/db/sqlite`, `@wystack/db/mssql` later without root-level churn.
//
// Do NOT import from `drizzle-orm/pg-core` directly in consumer packages;
// route through this subpath so the dialect boundary stays a single-package
// concern.

export * from 'drizzle-orm/pg-core'

// Drizzle driver for PGlite.
export { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
