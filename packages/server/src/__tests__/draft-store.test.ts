import { afterEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import { ensureDraftStorage, listStoredDraftsForOwner } from '../draft-store'
import {
  installV2MetadataUpgradeFixture,
  installV7CustodyUpgradeFixture,
} from './draft-store.fixture'

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

describe('draft discovery storage', () => {
  test('rejects non-canonical owner-list cursors before issuing SQL', async () => {
    let executeCalls = 0
    const raw = {
      execute() {
        executeCalls += 1
        throw new Error('SQL must not run')
      },
    }

    for (const createdAt of [
      '0',
      '0000-01-01T00:00:00.000000Z',
      '2026-08-04T00:00:00.000Z',
      '2026-02-30T00:00:00.000000Z',
      '2026-08-04T24:00:00.000000Z',
    ]) {
      await expect(
        listStoredDraftsForOwner(raw, undefined, 'owner', {
          cursor: { createdAt, draftId: 'draft_invalid' },
        }),
      ).rejects.toThrow('owned draft cursor is invalid')
    }
    expect(executeCalls).toBe(0)
  })
})

describe('draft storage migrations', () => {
  test('installs durable lifecycle tables and bounded-listing indexes idempotently', async () => {
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
    const custodyIndexes = await db.execute(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE indexname IN (
         'wystack_drafts_custody_created_idx',
         'wystack_drafts_custody_lookup_idx'
       ) ORDER BY indexname`,
    )
    const hashFunction = await db.execute(
      `SELECT provolatile FROM pg_proc WHERE proname = 'jsonb_hash_extended'`,
    )
    const revisionLedger = await db.execute(
      `SELECT table_name FROM information_schema.tables
       WHERE table_name = 'wystack_row_revisions'`,
    )
    const integrityColumn = await db.execute(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'wystack_drafts' AND column_name = 'integrity_hash'`,
    )
    const discoveryColumns = await db.execute(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'wystack_drafts'
         AND column_name IN ('lookup_key', 'summary')
       ORDER BY column_name`,
    )
    const lookupConstraint = await db.execute(
      `SELECT pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conname = 'wystack_drafts_lookup_key_size_check'`,
    )
    const draftForeignKeys = await db.execute(
      `SELECT condeferrable, condeferred
       FROM pg_catalog.pg_constraint
       WHERE contype = 'f' AND confrelid = 'wystack_drafts'::regclass`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((migration as any).rows[0].version).toBe(8)
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((tables as any).rows.map((row: { table_name: string }) => row.table_name)).toEqual([
      'wystack_draft_commands',
      'wystack_draft_row_changes',
      'wystack_draft_tables',
      'wystack_drafts',
    ])
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((indexes as any).rows).toHaveLength(1)
    const discoveryIndexRows = (
      custodyIndexes as { rows: Array<{ indexname: string; indexdef: string }> }
    ).rows.map((row) => ({ ...row, indexdef: row.indexdef.replace(/\s+/g, ' ') }))
    expect(discoveryIndexRows).toHaveLength(2)
    expect(discoveryIndexRows[0]).toMatchObject({
      indexname: 'wystack_drafts_custody_created_idx',
      indexdef: expect.stringContaining(
        'jsonb_hash_extended(tenant_scope, (0)::bigint), jsonb_hash_extended(owner_key, (0)::bigint), created_at DESC, draft_id DESC',
      ),
    })
    expect(discoveryIndexRows[1]).toMatchObject({
      indexname: 'wystack_drafts_custody_lookup_idx',
      indexdef: expect.stringContaining(
        'jsonb_hash_extended(tenant_scope, (0)::bigint), jsonb_hash_extended(owner_key, (0)::bigint), lookup_key, created_at DESC, draft_id DESC',
      ),
    })
    expect((hashFunction as { rows: unknown[] }).rows).toEqual([{ provolatile: 'i' }])
    expect((revisionLedger as { rows: unknown[] }).rows).toHaveLength(1)
    expect((integrityColumn as { rows: unknown[] }).rows).toEqual([
      { column_name: 'integrity_hash', is_nullable: 'NO' },
    ])
    expect((discoveryColumns as { rows: unknown[] }).rows).toEqual([
      { column_name: 'lookup_key', is_nullable: 'YES' },
      { column_name: 'summary', is_nullable: 'NO' },
    ])
    expect(
      (lookupConstraint as { rows: Array<{ definition: string }> }).rows[0]?.definition,
    ).toContain('octet_length(lookup_key) >= 1')
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
    await expect(
      Promise.resolve(
        db.execute(sql`INSERT INTO wystack_drafts
          (draft_id, base_version, tenant_scope, owner_key, lookup_key, integrity_hash)
          VALUES (
            'oversized-lookup',
            '{"present":true,"value":0}'::jsonb,
            '{"present":false}'::jsonb,
            '{"present":true,"value":"owner"}'::jsonb,
            ${'界'.repeat(171)},
            'test'
          )`),
      ),
    ).rejects.toThrow('Failed query')
    const rejectedLookup = await db.execute(
      `SELECT draft_id FROM wystack_drafts WHERE draft_id = 'oversized-lookup'`,
    )
    expect((rejectedLookup as { rows: unknown[] }).rows).toEqual([])
  })

  test('upgrades v7 and lists an incompressible owner key without a full-JSONB btree entry', async () => {
    const pg = createTestDatabase()
    const db = drizzle(pg)
    let state = 0x9e3779b9
    const ownerBytes = Array.from({ length: 16_384 }, () => {
      state ^= state << 13
      state ^= state >>> 17
      state ^= state << 5
      return String.fromCharCode(33 + ((state >>> 0) % 90))
    }).join('')
    const ownerKey = { subject: ownerBytes }
    const ownerEnvelope = JSON.stringify({ present: true, value: ownerKey })

    await installV7CustodyUpgradeFixture(db)
    await db.execute(sql`INSERT INTO wystack_drafts
      (draft_id, base_version, tenant_scope, owner_key, integrity_hash)
      VALUES (
        'large-owner',
        '{"present":true,"value":7}'::jsonb,
        '{"present":false}'::jsonb,
        ${ownerEnvelope}::jsonb,
        'legacy'
      )`)

    await ensureDraftStorage(db)

    expect(await listStoredDraftsForOwner(db, undefined, ownerKey)).toMatchObject([
      {
        draftId: 'large-owner',
        baseVersion: 7,
        summary: undefined,
      },
    ])
    const indexes = await db.execute(
      `SELECT indexdef FROM pg_indexes
       WHERE indexname LIKE 'wystack_drafts_custody_%' ORDER BY indexname`,
    )
    expect((indexes as { rows: Array<{ indexdef: string }> }).rows).toHaveLength(2)
    expect(
      (indexes as { rows: Array<{ indexdef: string }> }).rows.every(
        (row) =>
          row.indexdef.includes('jsonb_hash_extended(tenant_scope') &&
          row.indexdef.includes('jsonb_hash_extended(owner_key'),
      ),
    ).toBe(true)
  })

  test('upgrades v2 touched-table metadata without replacing durable rows', async () => {
    const pg = createTestDatabase()
    const db = drizzle(pg)
    await db.execute(`CREATE SCHEMA other_storage`)
    await db.execute(`CREATE TABLE other_storage.wystack_draft_tables (invalidation_tag TEXT)`)
    await installV2MetadataUpgradeFixture(db)
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
