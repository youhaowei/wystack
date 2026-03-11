import type { PgTableWithColumns } from 'drizzle-orm/pg-core'

export type TableDef = PgTableWithColumns<any>

export type WyStackSchema = Record<string, TableDef>

export interface DbConfig {
  dev?: string
  prod?: string
  url?: string
}

export type Db = any // Will be narrowed to Drizzle instance type
