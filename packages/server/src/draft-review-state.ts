import {
  draftInvalidationIdentity,
  resolvePkColumnName,
  tryGetTableCapabilities,
  type DraftDrizzleTracker,
  type DrizzleTracker,
} from '@wystack/db'
import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { decodeJsonColumn, normalizeRows } from './draft-inspection'
import type { StoredTouchedTable } from './draft-store'
import { DraftConflictError, type Cell, type DraftRowConflict } from './draft-lifecycle-types'

export { inspectDraftRows } from './draft-inspection'
export { applyReviewedChanges, assertReplayMatchesReviewedChanges } from './draft-publication'

type AnyTable = Parameters<DrizzleTracker['from']>[0]

function qualifiedTableKey(table: AnyTable): string {
  const name = getTableName(table)
  const schema = getTableConfig(table).schema
  return schema ? `${schema}.${name}` : name
}

function normalizeSqlType(type: string): string {
  const normalized = type.toLowerCase()
  if (normalized === 'serial') return 'integer'
  if (normalized === 'bigserial') return 'bigint'
  if (normalized === 'smallserial') return 'smallint'
  return normalized
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function identityCast(type: string): string {
  const normalized = normalizeSqlType(type)
  if (
    !['integer', 'bigint', 'smallint', 'text', 'uuid'].includes(normalized) &&
    !/^varchar(?:\(\d+\))?$/.test(normalized)
  ) {
    throw new Error(`draft lifecycle: unsupported persisted identity type "${type}"`)
  }
  return normalized
}

export function describeTouchedTables(
  touchedTables: Map<string, AnyTable>,
  draftWrites: Set<string>,
  draftId: string,
  tenantId: unknown | undefined,
): StoredTouchedTable[] {
  return [...touchedTables.values()].flatMap((table) => {
    const tableName = getTableName(table)
    const config = getTableConfig(table)
    const qualifiedName = qualifiedTableKey(table)
    const draftTag = draftInvalidationIdentity(table, draftId, tenantId)
    if (!draftWrites.has(draftTag)) return []
    const columns = getTableColumns(table) as Record<string, { name: string; getSQLType(): string }>
    const pkColumn = resolvePkColumnName(table, config)
    const pk = Object.values(columns).find((column) => column.name === pkColumn)
    if (!pk) throw new Error(`draft lifecycle: cannot resolve primary key for "${qualifiedName}"`)
    const capabilities = tryGetTableCapabilities(table)
    const tenant = capabilities?.tenancy ? columns[capabilities.tenancy.property] : undefined
    return [
      {
        schema: config.schema,
        table: tableName,
        pkColumn,
        pkType: normalizeSqlType(pk.getSQLType()),
        tenantColumn: tenant?.name,
        tenantType: tenant ? normalizeSqlType(tenant.getSQLType()) : undefined,
        revisionColumn: liveRevisionColumn(table),
        invalidationTag: draftTag,
      },
    ]
  })
}

/** The revision column the live schema declares for `table`, if any. */
function liveRevisionColumn(table: AnyTable): string | undefined {
  const property = tryGetTableCapabilities(table)?.revisionProperty
  if (!property) return undefined
  const columns = getTableColumns(table) as Record<string, { name: string }>
  return columns[property]?.name
}

/**
 * The stored descriptor is a snapshot of each touched table as it was at the
 * last append; the compare-and-swap in `assertDraftRowsUnchanged` can only
 * express what that snapshot knew. If the live schema has since added or
 * removed a table's revision column, the check just performed did not cover
 * what it now owes, so publish fails closed. Runs after the replay, inside the
 * same transaction, so the conflict rolls the whole publish back. Rebase
 * rebuilds the descriptor and base revisions from the live schema.
 */
export async function assertStoredDescriptorsCurrent(
  raw: DrizzleTracker['raw'],
  draftId: string,
  stored: StoredTouchedTable[],
  liveTables: Map<string, AnyTable>,
): Promise<void> {
  const conflicts: DraftRowConflict[] = []
  for (const table of stored) {
    const tableIdentity = table.schema ? `${table.schema}.${table.table}` : table.table
    const live = liveTables.get(tableIdentity)
    if (!live || liveRevisionColumn(live) === table.revisionColumn) continue
    const rows = normalizeRows(
      await raw.execute(sql`
        SELECT row_key FROM wystack_draft_row_changes
        WHERE base_exists AND draft_id = ${draftId} AND table_key = ${tableIdentity}
        ORDER BY tenant_key_text, row_key_text
      `),
    )
    for (const row of rows) {
      const key = decodeJsonColumn(row['row_key']) as { value?: unknown }
      conflicts.push({
        table: tableIdentity,
        id: key.value,
        reason: 'revision',
      })
    }
  }
  if (conflicts.length > 0) throw new DraftConflictError(draftId, conflicts)
}

/** Capture table objects; the committed draft tag later filters read-only candidates. */
export function recordTouchedTables(
  draftDb: DraftDrizzleTracker,
  touchedTables: Map<string, AnyTable>,
): DraftDrizzleTracker {
  const record = (table: AnyTable) => touchedTables.set(qualifiedTableKey(table), table)
  return {
    tablesRead: draftDb.tablesRead,
    tablesWritten: draftDb.tablesWritten,
    raw: draftDb.raw,
    from(table) {
      record(table)
      return draftDb.from(table)
    },
    into(table) {
      record(table)
      return draftDb.into(table)
    },
    transaction: draftDb.transaction.bind(draftDb),
  }
}

export async function assertDraftRowsUnchanged(
  raw: DrizzleTracker['raw'],
  draftId: string,
  touchedTables: StoredTouchedTable[],
): Promise<void> {
  const conflicts: DraftRowConflict[] = []
  for (const table of touchedTables) {
    const tableIdentity = table.schema ? `${table.schema}.${table.table}` : table.table
    const relation = table.schema
      ? `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`
      : quoteIdentifier(table.table)
    const pk = quoteIdentifier(table.pkColumn)
    const pkValue = `(d.row_key #>> '{value}')::${identityCast(table.pkType)}`
    const tenantJoin =
      table.tenantColumn && table.tenantType
        ? ` AND c.${quoteIdentifier(table.tenantColumn)} = (d.tenant_key #>> '{value}')::${identityCast(table.tenantType)}`
        : ''
    const revisionLedgerJoin = table.revisionColumn
      ? ` LEFT JOIN wystack_row_revisions r ON r.table_key = d.table_key ` +
        `AND r.tenant_key_text = d.tenant_key_text AND r.row_key_text = d.row_key_text`
      : ''

    if (table.revisionColumn) {
      await raw.execute(
        sql`${sql.raw(
          `SELECT r.revision FROM wystack_row_revisions r ` +
            `JOIN wystack_draft_row_changes d ON r.table_key = d.table_key ` +
            `AND r.tenant_key_text = d.tenant_key_text AND r.row_key_text = d.row_key_text ` +
            `WHERE d.draft_id = `,
        )}${draftId}${sql.raw(' AND d.table_key = ')}${tableIdentity}${sql.raw(
          ' ORDER BY r.table_key COLLATE "C", r.tenant_key_text COLLATE "C", r.row_key_text COLLATE "C" FOR UPDATE OF r',
        )}`,
      )
    }

    await raw.execute(
      sql`${sql.raw(
        `SELECT c.${pk} FROM ${relation} c JOIN wystack_draft_row_changes d ` +
          `ON c.${pk} = ${pkValue}${tenantJoin} WHERE d.draft_id = `,
      )}${draftId}${sql.raw(' AND d.table_key = ')}${tableIdentity}${sql.raw(
        ' ORDER BY d.table_key COLLATE "C", d.tenant_key_text COLLATE "C", d.row_key_text COLLATE "C" FOR UPDATE OF c',
      )}`,
    )

    const revisionConflict = table.revisionColumn
      ? ` OR r.revision IS NULL` +
        ` OR (d.base_exists AND (c.${quoteIdentifier(table.revisionColumn)} IS NULL OR d.base_revision IS DISTINCT FROM to_jsonb(c.${quoteIdentifier(table.revisionColumn)})))` +
        ` OR (NOT d.base_exists AND c.${pk} IS NULL AND d.base_revision IS DISTINCT FROM to_jsonb(r.revision))`
      : ''
    const rows = normalizeRows(
      await raw.execute(
        sql`${sql.raw(
          `SELECT d.row_key, CASE ` +
            `WHEN NOT d.base_exists AND c.${pk} IS NOT NULL THEN 'created' ` +
            `WHEN d.base_exists AND c.${pk} IS NULL THEN 'deleted' ` +
            `ELSE 'revision' END AS reason ` +
            `FROM wystack_draft_row_changes d LEFT JOIN ${relation} c ` +
            `ON c.${pk} = ${pkValue}${tenantJoin}${revisionLedgerJoin} WHERE d.draft_id = `,
        )}${draftId}${sql.raw(' AND d.table_key = ')}${tableIdentity}${sql.raw(
          ` AND ((NOT d.base_exists AND c.${pk} IS NOT NULL) ` +
            `OR (d.base_exists AND c.${pk} IS NULL)${revisionConflict})`,
        )}`,
      ),
    )
    for (const row of rows) {
      const key = decodeJsonColumn(row['row_key']) as { value?: unknown }
      conflicts.push({
        table: tableIdentity,
        id: key.value,
        reason: String(row['reason']) as DraftRowConflict['reason'],
      })
    }
  }
  if (conflicts.length > 0) throw new DraftConflictError(draftId, conflicts)
}

export async function enumerateTouchedCells(
  raw: DrizzleTracker['raw'],
  draftId: string,
  touchedTables: StoredTouchedTable[],
): Promise<Cell[]> {
  const cells: Cell[] = []
  for (const table of touchedTables) {
    const tableIdentity = table.schema ? `${table.schema}.${table.table}` : table.table
    const rows = normalizeRows(
      await raw.execute(sql`
        SELECT tenant_key, row_key FROM wystack_draft_row_changes
        WHERE draft_id = ${draftId} AND table_key = ${tableIdentity}
        ORDER BY tenant_key_text, row_key_text
      `),
    )
    for (const row of rows) {
      const rowKey = decodeJsonColumn(row['row_key']) as { value?: unknown }
      const tenantKey = decodeJsonColumn(row['tenant_key']) as { value?: unknown } | null
      cells.push({
        table: tableIdentity,
        id: rowKey?.value,
        ...(tenantKey ? { tenantId: tenantKey.value } : {}),
      })
    }
  }
  return cells
}

export async function clearDerivedChanges(
  // oxlint-disable-next-line typescript/no-explicit-any -- DrizzleDb varies by driver
  raw: any,
  draftId: string,
): Promise<void> {
  await raw.execute(sql`DELETE FROM wystack_draft_row_changes WHERE draft_id = ${draftId}`)
}
