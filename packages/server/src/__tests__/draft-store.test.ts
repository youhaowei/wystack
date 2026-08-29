import { afterEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { ensureDraftStorage } from '../draft-store'

const openDatabases = new Set<PGlite>()

function createTestDatabase(): PGlite {
  const pg = new PGlite()
  openDatabases.add(pg)
  return pg
}

afterEach(async () => {
  const databases = [...openDatabases]
  openDatabases.clear()
  await Promise.all(databases.map((pg) => pg.close()))
})

describe('draft storage migrations', () => {
  test('installs durable lifecycle tables and the whole-draft lookup index idempotently', async () => {
    const pg = createTestDatabase()
    const db = drizzle(pg)

    await Promise.all([ensureDraftStorage(db), ensureDraftStorage(db)])
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
    const revisionLedger = await db.execute(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name = 'wystack_row_revisions'`,
    )
    const integrityColumn = await db.execute(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'wystack_drafts' AND column_name = 'integrity_hash'`,
    )
    const draftForeignKeys = await db.execute(
      `SELECT condeferrable, condeferred
       FROM pg_catalog.pg_constraint
       WHERE contype = 'f' AND confrelid = 'wystack_drafts'::regclass`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((migration as any).rows[0].version).toBe(7)
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((tables as any).rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'wystack_draft_commands',
      'wystack_draft_row_changes',
      'wystack_draft_tables',
      'wystack_drafts',
    ])
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((indexes as any).rows).toHaveLength(1)
    expect((revisionLedger as { rows: unknown[] }).rows).toHaveLength(1)
    expect((integrityColumn as { rows: unknown[] }).rows).toEqual([
      { column_name: 'integrity_hash', is_nullable: 'NO' },
    ])
    expect(
      (draftForeignKeys as { rows: Array<Record<string, unknown>> }).rows.length,
    ).toBeGreaterThan(2)
    expect((draftForeignKeys as { rows: Array<Record<string, unknown>> }).rows).toEqual(
      expect.arrayContaining([expect.objectContaining({ condeferrable: true, condeferred: true })]),
    )
    expect(
      (draftForeignKeys as { rows: Array<Record<string, unknown>> }).rows.every(
        (row) => row['condeferrable'] === true && row['condeferred'] === true,
      ),
    ).toBe(true)
  })

  test('upgrades v2 touched-table metadata without replacing durable rows', async () => {
    const pg = createTestDatabase()
    const db = drizzle(pg)
    await db.execute(`CREATE SCHEMA other_storage`)
    await db.execute(`CREATE TABLE other_storage.wystack_draft_tables (invalidation_tag TEXT)`)
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
    await db.execute(`CREATE TABLE kept_items (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`)
    await db.execute(`INSERT INTO kept_items VALUES (7, 'canonical')`)
    await db.execute(`CREATE TABLE kept_documents (id UUID PRIMARY KEY, title TEXT NOT NULL)`)
    await db.execute(
      `INSERT INTO kept_documents VALUES ('2b21e2cc-54a1-4484-94dd-c14cda029fc4', 'canonical')`,
    )
    await db.execute(
      `INSERT INTO wystack_draft_commands (draft_id, position, command)
       VALUES ('kept', 0, '{"path":"rename","args":{"id":7}}')`,
    )
    await db.execute(
      `INSERT INTO wystack_draft_tables
        (draft_id, schema_name, table_name, pk_column, shadow_tag)
       VALUES
        ('kept', '', 'kept_items', 'id', 'draft:kept:kept_items'),
        ('kept', '', 'kept_documents', 'id', 'draft:kept:kept_documents')`,
    )
    await db.execute(
      `INSERT INTO wystack_draft_row_changes
        (draft_id, table_key, row_key_text, row_key, operation, base_exists, fields)
       VALUES ('kept', 'kept_items', '7', '{"type":"integer","value":7}',
         'update', true, '{"title":{"original":{"kind":"value","value":"canonical"},"value":{"kind":"value","value":"draft"}}}')`,
    )

    await ensureDraftStorage(db)

    const columns = await db.execute(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'wystack_draft_tables' ORDER BY column_name`,
    )
    const draft = await db.execute(
      `SELECT draft_id, integrity_hash FROM wystack_drafts WHERE draft_id = 'kept'`,
    )
    const touched = await db.execute(
      `SELECT table_name, pk_type, invalidation_tag FROM wystack_draft_tables
       WHERE draft_id = 'kept' ORDER BY table_name`,
    )
    const joined = await db.execute(
      `SELECT c.id FROM kept_items c JOIN wystack_draft_row_changes d
       ON c.id = (d.row_key #>> '{value}')::integer WHERE d.draft_id = 'kept'`,
    )
    const command = await db.execute(
      `SELECT command FROM wystack_draft_commands WHERE draft_id = 'kept'`,
    )
    const columnNames = (columns as { rows: Array<{ column_name: string }> }).rows.map(
      (row) => row.column_name,
    )
    expect(columnNames).toContain('revision_column')
    expect(columnNames).toContain('invalidation_tag')
    expect(columnNames).not.toContain('shadow_tag')
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((draft as any).rows).toEqual([
      { draft_id: 'kept', integrity_hash: expect.stringMatching(/^[0-9a-f]{32}$/) },
    ])
    expect((touched as { rows: unknown[] }).rows).toEqual([
      {
        table_name: 'kept_documents',
        pk_type: 'uuid',
        invalidation_tag: 'draft:kept:kept_documents',
      },
      {
        table_name: 'kept_items',
        pk_type: 'integer',
        invalidation_tag: 'draft:kept:kept_items',
      },
    ])
    expect((joined as { rows: unknown[] }).rows).toEqual([{ id: 7 }])
    expect((command as { rows: unknown[] }).rows).toHaveLength(1)
  })

  test('a v5 upgrade forces active revisioned drafts to rebase', async () => {
    const pg = createTestDatabase()
    const db = drizzle(pg)
    await ensureDraftStorage(db)
    await db.execute(`
      INSERT INTO wystack_drafts
        (draft_id, base_version, tenant_scope, owner_key, integrity_hash)
      VALUES
        ('pre-v5', '{"present":true,"value":0}', '{"present":false}', '{"present":false}', 'legacy')
    `)
    await db.execute(`
      INSERT INTO wystack_draft_tables
        (draft_id, schema_name, table_name, pk_column, pk_type, revision_column)
      VALUES ('pre-v5', '', 'versioned_items', 'id', 'integer', 'revision')
    `)
    await db.execute(`
      INSERT INTO wystack_draft_row_changes
        (draft_id, table_key, row_key_text, row_key, operation, base_exists, base_revision, fields)
      VALUES ('pre-v5', 'versioned_items', '7', '{"type":"integer","value":7}',
        'update', true, '1', '{}')
    `)
    await db.execute(`
      UPDATE wystack_framework_migrations SET version = 4
      WHERE migration_name = 'draft-storage'
    `)

    await ensureDraftStorage(db)

    const change = await db.execute(`
      SELECT base_revision FROM wystack_draft_row_changes WHERE draft_id = 'pre-v5'
    `)
    expect((change as { rows: Array<{ base_revision: unknown }> }).rows).toEqual([
      {
        base_revision: {
          wystack: 'rebase-required',
          reason: 'revision-ledger-upgrade',
        },
      },
    ])
  })
})
