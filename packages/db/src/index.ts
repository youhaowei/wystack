// @wystack/db
// SQL-agnostic database layer with schema DSL, tracked queries, and change detection

export { defineSchema } from './schema'
export { createDb } from './driver'
export { createDrizzleTracker, resetTracking, resolvePkColumnName } from './drizzle-tracker'
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
} from './drizzle-tracker'
export type { WyStackSchema, TableDef, DbConfig, Db } from './types'
