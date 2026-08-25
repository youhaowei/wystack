import { describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { ensureDraftStorage } from '../draft-store'

describe('draft storage migrations', () => {
  test('installs durable lifecycle tables and the whole-draft lookup index idempotently', async () => {
    const pg = new PGlite()
    const db = drizzle(pg)

    await ensureDraftStorage(db)
    await ensureDraftStorage(db)

    const migration = await db.execute(
      `SELECT version FROM wystack_framework_migrations WHERE migration_name = 'draft-storage'`,
    )
    const tables = await db.execute(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name LIKE 'wystack_draft%' ORDER BY table_name`,
    )
    const indexes = await db.execute(
      `SELECT indexname FROM pg_indexes
       WHERE indexname = 'wystack_draft_row_changes_draft_table_idx'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((migration as any).rows[0].version).toBe(3)
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((tables as any).rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'wystack_draft_commands',
      'wystack_draft_row_changes',
      'wystack_draft_tables',
      'wystack_drafts',
    ])
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((indexes as any).rows).toHaveLength(1)
  })

  test('upgrades v2 touched-table metadata without replacing durable rows', async () => {
    const pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(`
      CREATE TABLE wystack_framework_migrations (
        migration_name TEXT PRIMARY KEY, version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)
    `)
    await db.execute(`
      CREATE TABLE wystack_drafts (
        draft_id TEXT PRIMARY KEY, base_version JSONB NOT NULL, tenant_scope JSONB NOT NULL,
        owner_key JSONB NOT NULL, log_revision INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)
    `)
    await db.execute(`
      CREATE TABLE wystack_draft_commands (
        draft_id TEXT NOT NULL REFERENCES wystack_drafts(draft_id) ON DELETE CASCADE,
        position INTEGER NOT NULL, command JSONB NOT NULL, PRIMARY KEY (draft_id, position))
    `)
    await db.execute(`
      CREATE TABLE wystack_draft_tables (
        draft_id TEXT NOT NULL REFERENCES wystack_drafts(draft_id) ON DELETE CASCADE,
        schema_name TEXT NOT NULL DEFAULT '', table_name TEXT NOT NULL,
        pk_column TEXT NOT NULL, shadow_tag TEXT,
        PRIMARY KEY (draft_id, schema_name, table_name))
    `)
    await db.execute(`
      CREATE TABLE wystack_draft_row_changes (
        draft_id TEXT NOT NULL, table_key TEXT NOT NULL,
        tenant_key_text TEXT NOT NULL DEFAULT '', tenant_key JSONB,
        row_key_text TEXT NOT NULL, row_key JSONB NOT NULL, operation TEXT NOT NULL,
        base_exists BOOLEAN NOT NULL, base_revision JSONB, fields JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (draft_id, table_key, tenant_key_text, row_key_text))
    `)
    await db.execute(
      `INSERT INTO wystack_framework_migrations (migration_name, version) VALUES ('draft-storage', 2)`,
    )
    await db.execute(
      `INSERT INTO wystack_drafts (draft_id, base_version, tenant_scope, owner_key)
       VALUES ('kept', '{"present":true,"value":0}', '{"present":false}', '{"present":false}')`,
    )

    await ensureDraftStorage(db)

    const columns = await db.execute(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'wystack_draft_tables' ORDER BY column_name`,
    )
    const draft = await db.execute(`SELECT draft_id FROM wystack_drafts WHERE draft_id = 'kept'`)
    const columnNames = (columns as { rows: Array<{ column_name: string }> }).rows.map(
      (row) => row.column_name,
    )
    expect(columnNames).toContain('revision_column')
    expect(columnNames).toContain('invalidation_tag')
    expect(columnNames).not.toContain('shadow_tag')
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((draft as any).rows).toEqual([{ draft_id: 'kept' }])
  })
})
