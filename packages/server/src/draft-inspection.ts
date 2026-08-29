import type { DrizzleTracker } from '@wystack/db'
import { sql } from 'drizzle-orm'
import type { DraftInspectionRow } from './draft-lifecycle-types'

export async function inspectDraftRows(
  raw: DrizzleTracker['raw'],
  draftId: string,
): Promise<DraftInspectionRow[]> {
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT draft_id, table_key, tenant_key, row_key, operation,
             base_exists, base_revision, fields
      FROM wystack_draft_row_changes WHERE draft_id = ${draftId}
      ORDER BY table_key, tenant_key_text, row_key_text
    `),
  )
  return rows.map((row) => ({
    draftId: String(row['draft_id']),
    table: String(row['table_key']),
    tenantKey: decodeJsonColumn(row['tenant_key']),
    rowKey: decodeJsonColumn(row['row_key']),
    operation: String(row['operation']) as DraftInspectionRow['operation'],
    baseExists: Boolean(row['base_exists']),
    baseRevision: decodeJsonColumn(row['base_revision']),
    fields: decodeJsonColumn(row['fields']) as DraftInspectionRow['fields'],
  }))
}

export function decodeJsonColumn(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

export function normalizeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}
