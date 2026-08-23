// @wystack/db
// SQL-agnostic database layer with schema DSL, tracked queries, and change detection

export { defineSchema, getGeneratedTables, getTableCapabilities } from './schema'
export { table, multiTenant, TableDefinition } from './table'
export { createDb } from './driver'
export {
  createDrizzleTracker,
  resetTracking,
  resolvePkColumnName,
  draftJsonNull,
  enumerateDraftRowChanges,
} from './drizzle-tracker'
export { syncSchema, renderCreateTableIfNotExists } from './sync'
export { text, int, boolean, timestamp, jsonb, uuid, ColumnDef } from './dsl'
export { eq, ne, gt, gte, lt, lte } from './operators'

export type {
  AnyColumnDef,
  ColumnType,
  ColumnDefOptions,
  RefOptions,
  InferColumn,
  InferTable,
} from './dsl'
export type {
  ColumnDefinitions,
  MultiTenantDescriptor,
  TableCapabilities,
  TenantKeyDefinition,
} from './table'
export type { FilterOp, FilterDescriptor } from './operators'
export type { SyncTarget } from './sync'
export type {
  DrizzleTracker,
  DraftDrizzleTracker,
  SelectBuilder,
  DraftSelectBuilder,
  InsertBuilder,
  DraftInsertBuilder,
  TransactionOptions,
  DraftJsonNull,
  DraftRowChange,
  DraftStoredValue,
} from './drizzle-tracker'
export type { WyStackSchema, TableDef, DbConfig, Db } from './types'
