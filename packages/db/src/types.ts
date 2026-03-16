import type { PgTableWithColumns } from 'drizzle-orm/pg-core'

// oxlint-disable-next-line typescript/no-explicit-any -- PgTableWithColumns config generic requires any for polymorphic schema usage
export type TableDef = PgTableWithColumns<any>

export type WyStackSchema = Record<string, TableDef>

export interface DbConfig {
  dev?: string
  prod?: string
  url?: string
}

// oxlint-disable-next-line typescript/no-explicit-any -- Drizzle DB instance type varies by driver (PGlite, node-postgres, etc.)
export type Db = any
