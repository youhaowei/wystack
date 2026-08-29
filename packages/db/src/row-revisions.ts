import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { encodeTypedKey, noTenantScope, requireTenantScope } from './tracker-core'
import type { AnyTable, DrizzleDb, TenantScope } from './tracker-core'
import { normalizeExecuteRows, resolvePkColumnName } from './tracker-codecs'
import { withFrameworkBootstrapLock } from './framework-storage'

const utf8Encoder = new TextEncoder()

export interface RowRevisionSortKey {
  tableKey: Uint8Array
  tenantKey: Uint8Array
  rowKey: Uint8Array
}

export const rowRevisionStorageDdl = sql.raw(`CREATE TABLE IF NOT EXISTS wystack_row_revisions (
  table_key TEXT NOT NULL,
  tenant_key_text TEXT NOT NULL DEFAULT '',
  row_key_text TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (table_key, tenant_key_text, row_key_text)
)`)

export async function ensureRowRevisionStorage(raw: DrizzleDb): Promise<void> {
  await withFrameworkBootstrapLock(raw, async (tx) => {
    await tx.execute(rowRevisionStorageDdl)
  })
}

function revisionIdentity(table: AnyTable, tenantScope: TenantScope, row: Record<string, unknown>) {
  const config = getTableConfig(table)
  const tableName = getTableName(table)
  const tableKey = config.schema ? `${config.schema}.${tableName}` : tableName
  // oxlint-disable-next-line typescript/no-explicit-any -- heterogeneous Drizzle columns
  const columns = getTableColumns(table) as Record<string, any>
  const pkColumnName = resolvePkColumnName(table, config)
  const pkEntry = Object.entries(columns).find(([, column]) => column.name === pkColumnName)
  if (!pkEntry) throw new Error(`Cannot resolve revision identity for table "${tableKey}"`)
  const [pkProperty, pkColumn] = pkEntry
  const pkValue = row[pkProperty]
  if (pkValue === null || pkValue === undefined) {
    throw new Error(`Revisioned insert requires primary key "${pkProperty}"`)
  }

  const tenant = requireTenantScope(table, tenantScope)
  const tenantKey = tenant
    ? encodeTypedKey(columns[tenant.tenancy.property], tenant.tenantId).text
    : ''

  return {
    tableKey,
    tenantKey,
    rowKey: encodeTypedKey(pkColumn, pkValue).text,
  }
}

function compareUtf8Bytes(leftBytes: Uint8Array, rightBytes: Uint8Array): number {
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!
    if (difference !== 0) return difference
  }
  return leftBytes.length - rightBytes.length
}

/** Precompute the PostgreSQL C-collation identity used by hot lock-order sorts. */
export function rowRevisionSortKey(
  table: AnyTable,
  tenantScope: TenantScope,
  row: Record<string, unknown>,
): RowRevisionSortKey {
  const identity = revisionIdentity(table, tenantScope, row)
  return {
    tableKey: utf8Encoder.encode(identity.tableKey),
    tenantKey: utf8Encoder.encode(identity.tenantKey),
    rowKey: utf8Encoder.encode(identity.rowKey),
  }
}

export function compareRowRevisionSortKeys(
  left: RowRevisionSortKey,
  right: RowRevisionSortKey,
): number {
  for (const property of ['tableKey', 'tenantKey', 'rowKey'] as const) {
    const comparison = compareUtf8Bytes(left[property], right[property])
    if (comparison !== 0) return comparison
  }
  return 0
}

/** Match PostgreSQL's explicit `COLLATE "C"` revision-ledger lock order. */
export function compareRowRevisionRows(
  table: AnyTable,
  tenantScope: TenantScope,
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): number {
  return compareRowRevisionSortKeys(
    rowRevisionSortKey(table, tenantScope, left),
    rowRevisionSortKey(table, tenantScope, right),
  )
}

/** Establish and row-lock an identity, including one never inserted before. */
export async function lockRowRevision(
  raw: DrizzleDb,
  table: AnyTable,
  tenantScope: TenantScope,
  row: Record<string, unknown>,
): Promise<void> {
  const identity = revisionIdentity(table, tenantScope, row)
  await raw.execute(sql`
    INSERT INTO wystack_row_revisions (table_key, tenant_key_text, row_key_text, revision)
    VALUES (${identity.tableKey}, ${identity.tenantKey}, ${identity.rowKey}, 0)
    ON CONFLICT (table_key, tenant_key_text, row_key_text)
    DO UPDATE SET revision = wystack_row_revisions.revision
  `)
}

/** Allocate the next durable incarnation token before a canonical insert. */
export async function allocateRowRevision(
  raw: DrizzleDb,
  table: AnyTable,
  tenantScope: TenantScope = noTenantScope,
  row: Record<string, unknown>,
): Promise<number> {
  const identity = revisionIdentity(table, tenantScope, row)
  const result = await raw.execute(sql`
    INSERT INTO wystack_row_revisions (table_key, tenant_key_text, row_key_text, revision)
    VALUES (${identity.tableKey}, ${identity.tenantKey}, ${identity.rowKey}, 1)
    ON CONFLICT (table_key, tenant_key_text, row_key_text)
    DO UPDATE SET revision = wystack_row_revisions.revision + 1
    RETURNING revision
  `)
  const revision = Number(normalizeExecuteRows(result)[0]?.['revision'])
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`Could not allocate a revision for "${identity.tableKey}"`)
  }
  return revision
}

/** Preserve the last visible token before deleting a canonical row. */
export async function preserveRowRevision(
  raw: DrizzleDb,
  table: AnyTable,
  tenantScope: TenantScope,
  row: Record<string, unknown>,
  revisionProperty: string,
): Promise<void> {
  const identity = revisionIdentity(table, tenantScope, row)
  const revision = Number(row[revisionProperty])
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`Revision property "${revisionProperty}" must contain a positive integer`)
  }
  await raw.execute(sql`
    INSERT INTO wystack_row_revisions (table_key, tenant_key_text, row_key_text, revision)
    VALUES (${identity.tableKey}, ${identity.tenantKey}, ${identity.rowKey}, ${revision})
    ON CONFLICT (table_key, tenant_key_text, row_key_text)
    DO UPDATE SET revision = GREATEST(wystack_row_revisions.revision, EXCLUDED.revision)
  `)
}
