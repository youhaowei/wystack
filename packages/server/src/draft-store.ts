import { sql } from 'drizzle-orm'
import type { DraftCommand, Version } from './draft-lifecycle'

// oxlint-disable-next-line typescript/no-explicit-any -- the server supports multiple Drizzle Postgres drivers
type RawDb = any

export interface StoredDraft {
  draftId: string
  baseVersion: Version
  logRevision: number
  tenantId: unknown | undefined
  ownerKey: unknown | undefined
}

export interface StoredTouchedTable {
  schema: string | undefined
  table: string
  pkColumn: string
  pkType: string
  tenantColumn: string | undefined
  tenantType: string | undefined
  revisionColumn: string | undefined
  invalidationTag: string | undefined
}

const migrationTableDdl = sql.raw(`CREATE TABLE IF NOT EXISTS wystack_framework_migrations (
  migration_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)`)

const draftStorageVersion = 4
const storageDdlV1 = [
  sql.raw(`CREATE TABLE IF NOT EXISTS wystack_drafts (
    draft_id TEXT PRIMARY KEY,
    base_version JSONB NOT NULL,
    tenant_scope JSONB NOT NULL,
    owner_key JSONB NOT NULL,
    log_revision INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`),
  sql.raw(`CREATE TABLE IF NOT EXISTS wystack_draft_commands (
    draft_id TEXT NOT NULL CONSTRAINT wystack_draft_commands_draft_fk
      REFERENCES wystack_drafts(draft_id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    command JSONB NOT NULL,
    PRIMARY KEY (draft_id, position)
  )`),
  sql.raw(`CREATE TABLE IF NOT EXISTS wystack_draft_tables (
    draft_id TEXT NOT NULL REFERENCES wystack_drafts(draft_id) ON DELETE CASCADE,
    schema_name TEXT NOT NULL DEFAULT '',
    table_name TEXT NOT NULL,
    pk_column TEXT NOT NULL,
    invalidation_tag TEXT,
    PRIMARY KEY (draft_id, schema_name, table_name)
  )`),
]

const storageDdlV2 = [
  sql.raw(`CREATE TABLE IF NOT EXISTS wystack_draft_row_changes (
    draft_id TEXT NOT NULL REFERENCES wystack_drafts(draft_id) ON DELETE CASCADE,
    table_key TEXT NOT NULL,
    tenant_key_text TEXT NOT NULL DEFAULT '',
    tenant_key JSONB,
    row_key_text TEXT NOT NULL,
    row_key JSONB NOT NULL,
    operation TEXT NOT NULL CONSTRAINT wystack_draft_row_changes_operation_check
      CHECK (operation IN ('insert', 'update', 'delete')),
    base_exists BOOLEAN NOT NULL,
    base_revision JSONB,
    fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (draft_id, table_key, tenant_key_text, row_key_text)
  )`),
]

const storageDdlV3 = [
  sql.raw(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'wystack_draft_tables' AND column_name = 'shadow_tag'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'wystack_draft_tables' AND column_name = 'invalidation_tag'
      ) THEN
        ALTER TABLE wystack_draft_tables RENAME COLUMN shadow_tag TO invalidation_tag;
      END IF;
    END $$`),
  sql.raw(`ALTER TABLE wystack_draft_tables
    ADD COLUMN IF NOT EXISTS pk_type TEXT NOT NULL DEFAULT 'text'`),
  sql.raw(`ALTER TABLE wystack_draft_tables
    ADD COLUMN IF NOT EXISTS tenant_column TEXT`),
  sql.raw(`ALTER TABLE wystack_draft_tables
    ADD COLUMN IF NOT EXISTS tenant_type TEXT`),
  sql.raw(`ALTER TABLE wystack_draft_tables
    ADD COLUMN IF NOT EXISTS revision_column TEXT`),
  sql.raw(`CREATE INDEX IF NOT EXISTS wystack_draft_row_changes_draft_table_idx
    ON wystack_draft_row_changes (draft_id, table_key, tenant_key_text)`),
  sql.raw(`DO $$
    BEGIN
      ALTER TABLE wystack_draft_row_changes
        ADD CONSTRAINT wystack_draft_row_changes_draft_fk
        FOREIGN KEY (draft_id) REFERENCES wystack_drafts(draft_id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`),
  sql.raw(`DO $$
    BEGIN
      ALTER TABLE wystack_draft_row_changes
        ADD CONSTRAINT wystack_draft_row_changes_operation_check
        CHECK (operation IN ('insert', 'update', 'delete'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`),
]

// v3 had to add pk_type to the v2 touched-table shape, but its DEFAULT 'text'
// silently mislabeled live integer and UUID drafts. Rebuild the metadata from
// PostgreSQL's catalog. If a referenced canonical table/column is gone or has
// an unsupported identity type, stop the migration instead of preserving a
// draft that can only fail later during publish with an invalid cast.
const storageDdlV4 = [
  sql.raw(`ALTER TABLE wystack_draft_tables ALTER COLUMN pk_type DROP NOT NULL`),
  sql.raw(`ALTER TABLE wystack_draft_tables ALTER COLUMN pk_type DROP DEFAULT`),
  sql.raw(`UPDATE wystack_draft_tables SET pk_type = NULL`),
  sql.raw(`UPDATE wystack_draft_tables d
    SET pk_type = CASE t.typname
      WHEN 'int2' THEN 'smallint'
      WHEN 'int4' THEN 'integer'
      WHEN 'int8' THEN 'bigint'
      WHEN 'text' THEN 'text'
      WHEN 'varchar' THEN 'varchar'
      WHEN 'uuid' THEN 'uuid'
      ELSE NULL
    END
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
    WHERE n.nspname = COALESCE(NULLIF(d.schema_name, ''), current_schema())
      AND c.relname = d.table_name
      AND a.attname = d.pk_column`),
  sql.raw(`DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM wystack_draft_tables WHERE pk_type IS NULL) THEN
        RAISE EXCEPTION 'draft storage migration cannot resolve an active draft primary-key type';
      END IF;
    END $$`),
  sql.raw(`ALTER TABLE wystack_draft_tables ALTER COLUMN pk_type SET NOT NULL`),
]

export async function ensureDraftStorage(raw: RawDb): Promise<void> {
  await raw.execute(migrationTableDdl)
  await raw.execute(sql`
    INSERT INTO wystack_framework_migrations (migration_name, version)
    VALUES ('draft-storage', 0)
    ON CONFLICT (migration_name) DO NOTHING
  `)

  await raw.transaction(async (tx: RawDb) => {
    const rows = normalizeRows(
      await tx.execute(sql`
      SELECT version
      FROM wystack_framework_migrations
      WHERE migration_name = 'draft-storage'
      FOR UPDATE
    `),
    )
    const installedVersion = Number(rows[0]?.['version'] ?? 0)
    if (installedVersion > draftStorageVersion) {
      throw new Error(
        `draft lifecycle: database schema version ${installedVersion} is newer than supported version ${draftStorageVersion}`,
      )
    }
    if (installedVersion === draftStorageVersion) return

    if (installedVersion < 1) {
      for (const statement of storageDdlV1) await tx.execute(statement)
    }
    if (installedVersion < 2) {
      for (const statement of storageDdlV2) await tx.execute(statement)
    }
    if (installedVersion < 3) {
      for (const statement of storageDdlV3) await tx.execute(statement)
    }
    if (installedVersion < 4) {
      for (const statement of storageDdlV4) await tx.execute(statement)
    }
    await tx.execute(sql`
      UPDATE wystack_framework_migrations
      SET version = ${draftStorageVersion}, applied_at = CURRENT_TIMESTAMP
      WHERE migration_name = 'draft-storage'
    `)
  })
}

export async function insertStoredDraft(
  raw: RawDb,
  draft: Omit<StoredDraft, 'logRevision'>,
): Promise<void> {
  const baseVersion = encodeEnvelope(draft.baseVersion, 'base version')
  const tenantScope = encodeEnvelope(draft.tenantId, 'tenant scope')
  const ownerKey = encodeEnvelope(draft.ownerKey, 'owner key')
  await raw.execute(sql`
    INSERT INTO wystack_drafts
      (draft_id, base_version, tenant_scope, owner_key, log_revision)
    VALUES
      (${draft.draftId}, ${baseVersion}::jsonb, ${tenantScope}::jsonb, ${ownerKey}::jsonb, 0)
  `)
}

export async function readStoredDraft(
  raw: RawDb,
  draftId: string,
  lock = false,
): Promise<StoredDraft | undefined> {
  const lockClause = lock ? sql.raw(' FOR UPDATE') : sql.empty()
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT draft_id, base_version, tenant_scope, owner_key, log_revision
      FROM wystack_drafts
      WHERE draft_id = ${draftId}${lockClause}
    `),
  )
  const row = rows[0]
  if (!row) return undefined
  return {
    draftId: String(row['draft_id']),
    baseVersion: decodeEnvelope(row['base_version']),
    logRevision: Number(row['log_revision']),
    tenantId: decodeEnvelope(row['tenant_scope']),
    ownerKey: decodeEnvelope(row['owner_key']),
  }
}

export async function readStoredCommands(raw: RawDb, draftId: string): Promise<DraftCommand[]> {
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT command
      FROM wystack_draft_commands
      WHERE draft_id = ${draftId}
      ORDER BY position
    `),
  )
  return rows.map((row) => decodeJsonColumn(row['command']) as DraftCommand)
}

export async function replaceStoredCommands(
  raw: RawDb,
  draftId: string,
  commands: DraftCommand[],
): Promise<void> {
  await raw.execute(sql`DELETE FROM wystack_draft_commands WHERE draft_id = ${draftId}`)
  for (let position = 0; position < commands.length; position++) {
    const command = encodeJson(commands[position], 'draft command')
    await raw.execute(sql`
      INSERT INTO wystack_draft_commands (draft_id, position, command)
      VALUES (${draftId}, ${position}, ${command}::jsonb)
    `)
  }
}

export async function advanceStoredDraftRevision(
  raw: RawDb,
  draftId: string,
  expectedRevision: number,
): Promise<void> {
  const rows = normalizeRows(
    await raw.execute(sql`
      UPDATE wystack_drafts
      SET log_revision = log_revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ${draftId} AND log_revision = ${expectedRevision}
      RETURNING log_revision
    `),
  )
  if (rows.length !== 1) {
    throw new Error(`draft lifecycle: draft "${draftId}" changed concurrently`)
  }
}

export async function upsertStoredTouchedTables(
  raw: RawDb,
  draftId: string,
  tables: StoredTouchedTable[],
): Promise<void> {
  for (const table of tables) {
    await raw.execute(sql`
      INSERT INTO wystack_draft_tables
        (draft_id, schema_name, table_name, pk_column, pk_type,
         tenant_column, tenant_type, revision_column, invalidation_tag)
      VALUES
        (${draftId}, ${table.schema ?? ''}, ${table.table}, ${table.pkColumn}, ${table.pkType},
         ${table.tenantColumn ?? null}, ${table.tenantType ?? null},
         ${table.revisionColumn ?? null}, ${table.invalidationTag ?? null})
      ON CONFLICT (draft_id, schema_name, table_name)
      DO UPDATE SET
        pk_column = EXCLUDED.pk_column,
        pk_type = EXCLUDED.pk_type,
        tenant_column = EXCLUDED.tenant_column,
        tenant_type = EXCLUDED.tenant_type,
        revision_column = EXCLUDED.revision_column,
        invalidation_tag = COALESCE(
          EXCLUDED.invalidation_tag,
          wystack_draft_tables.invalidation_tag
        )
    `)
  }
}

export async function readStoredTouchedTables(
  raw: RawDb,
  draftId: string,
): Promise<StoredTouchedTable[]> {
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT schema_name, table_name, pk_column, pk_type,
             tenant_column, tenant_type, revision_column, invalidation_tag
      FROM wystack_draft_tables
      WHERE draft_id = ${draftId}
      ORDER BY schema_name, table_name
    `),
  )
  return rows.map((row) => ({
    schema: row['schema_name'] === '' ? undefined : String(row['schema_name']),
    table: String(row['table_name']),
    pkColumn: String(row['pk_column']),
    pkType: String(row['pk_type']),
    tenantColumn: row['tenant_column'] == null ? undefined : String(row['tenant_column']),
    tenantType: row['tenant_type'] == null ? undefined : String(row['tenant_type']),
    revisionColumn: row['revision_column'] == null ? undefined : String(row['revision_column']),
    invalidationTag: row['invalidation_tag'] == null ? undefined : String(row['invalidation_tag']),
  }))
}

export async function replaceStoredDraftBase(
  raw: RawDb,
  draftId: string,
  baseVersion: Version,
  expectedRevision: number,
): Promise<void> {
  const encoded = encodeEnvelope(baseVersion, 'base version')
  const rows = normalizeRows(
    await raw.execute(sql`
      UPDATE wystack_drafts
      SET base_version = ${encoded}::jsonb,
          log_revision = log_revision + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE draft_id = ${draftId} AND log_revision = ${expectedRevision}
      RETURNING log_revision
    `),
  )
  if (rows.length !== 1) {
    throw new Error(`draft lifecycle: draft "${draftId}" changed concurrently`)
  }
}

export async function deleteStoredTouchedTables(raw: RawDb, draftId: string): Promise<void> {
  await raw.execute(sql`DELETE FROM wystack_draft_tables WHERE draft_id = ${draftId}`)
}

export async function deleteStoredDraft(raw: RawDb, draftId: string): Promise<void> {
  await raw.execute(sql`DELETE FROM wystack_drafts WHERE draft_id = ${draftId}`)
}

function encodeEnvelope(value: unknown, label: string): string {
  return encodeJson({ present: value !== undefined, value }, label)
}

function decodeEnvelope(value: unknown): unknown {
  const envelope = decodeJsonColumn(value) as { present?: boolean; value?: unknown }
  return envelope.present ? envelope.value : undefined
}

function encodeJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('value is not JSON-serializable')
    return encoded
  } catch (cause) {
    throw new Error(`draft lifecycle: ${label} must be JSON-serializable`, { cause })
  }
}

function decodeJsonColumn(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function normalizeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}
