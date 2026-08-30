// @wystack/db
// SQL-agnostic database layer with schema DSL, tracked queries, and change detection

export {
  adoptSchema,
  defineSchema,
  getGeneratedTables,
  getTableCapabilities,
  tryGetTableCapabilities,
} from './schema'
export { table, multiTenant, TableDefinition } from './table'
export { createDb } from './driver'
export {
  createDrizzleTracker,
  resetTracking,
  resolvePkColumnName,
  jsonNull,
  publishedInvalidationIdentity,
  draftInvalidationIdentity,
  softDeleteProperty,
} from './drizzle-tracker'
export { syncSchema, renderCreateTableIfNotExists } from './sync'
export { migrateTenantPrimaryKeys } from './tenant-primary-migration'
export { ensureRowRevisionStorage } from './row-revisions'
export { withFrameworkBootstrapLock } from './framework-storage'
export { text, int, boolean, timestamp, jsonb, uuid, ColumnDef } from './dsl'
export {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
} from './operators'

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
export type { AdoptedTableConfig } from './schema'
export type {
  ComparisonFilterDescriptor,
  ComparisonFilterOp,
  FilterDescriptor,
  FilterOp,
  LogicalFilterDescriptor,
  LogicalFilterOp,
  MembershipFilterDescriptor,
  MembershipFilterOp,
  NullFilterDescriptor,
  NullFilterOp,
} from './operators'
export type { SyncTarget } from './sync'
export type {
  TenantPrimaryKeyMigrationResult,
  TenantPrimaryKeyMigrationTarget,
} from './tenant-primary-migration'
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
