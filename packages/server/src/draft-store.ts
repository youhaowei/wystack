import { withFrameworkBootstrapLock } from '@wystack/db'
import { sql, type SQL } from 'drizzle-orm'
import type { DraftCommand } from './draft-command-log'
import {
  DEFAULT_OWNED_DRAFT_PAGE_SIZE,
  MAX_DRAFT_LOOKUP_KEY_BYTES,
  MAX_OWNED_DRAFT_PAGE_SIZE,
  DraftIntegrityError,
  type DraftSummary,
  type OwnedDraftCursor,
  type Version,
} from './draft-lifecycle-types'
import { snapshotDraftSummary } from './draft-summary'

// oxlint-disable-next-line typescript/no-explicit-any -- the server supports multiple Drizzle Postgres drivers
type RawDb = any

export interface StoredDraft {
  draftId: string
  baseVersion: Version
  logRevision: number
  tenantId: unknown | undefined
  ownerKey: unknown
  lookupKey: string | undefined
  summary: DraftSummary | undefined
}

export interface StoredDraftSummary {
  draftId: string
  baseVersion: Version
  createdAt: string
  updatedAt: string
  lookupKey: string | undefined
  summary: DraftSummary | undefined
  cursor: OwnedDraftCursor
}

export interface ListStoredDraftsForOwnerOptions {
  limit?: number
  cursor?: OwnedDraftCursor
}

export interface StoredDraftMetadataUpdate {
  summary?: DraftSummary
}

export interface StoredTouchedTable {
  schema: string | undefined
  table: string
  pkColumn: string
  pkType: string
  tenantColumn: string | undefined
  tenantType: string | undefined
  revisionColumn: string | undefined
  softDeleteColumn: string | undefined
  invalidationTag: string | undefined
}

const migrationTableDdl = sql.raw(`CREATE TABLE IF NOT EXISTS wystack_framework_migrations (
  migration_name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
)`)

function draftIntegrityExpression(
  draftId: SQL,
  opts: { includesSoftDeleteColumn?: boolean } = { includesSoftDeleteColumn: true },
): SQL {
  const softDeleteColumn =
    opts.includesSoftDeleteColumn === false ? sql.empty() : sql.raw(', t.soft_delete_column')
  return sql`md5(jsonb_build_object(
    'commands', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_array(c.position, c.command)
        ORDER BY c.position
      )
      FROM wystack_draft_commands c
      WHERE c.draft_id = ${draftId}
    ), '[]'::jsonb),
    'tables', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_array(
          t.schema_name, t.table_name, t.pk_column, t.pk_type,
          t.tenant_column, t.tenant_type, t.revision_column
          ${softDeleteColumn}, t.invalidation_tag
        )
        ORDER BY t.schema_name, t.table_name
      )
      FROM wystack_draft_tables t
      WHERE t.draft_id = ${draftId}
    ), '[]'::jsonb),
    'changes', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_array(
          r.table_key, r.tenant_key_text, r.tenant_key,
          r.row_key_text, r.row_key, r.operation, r.base_exists,
          r.base_revision, r.fields
        )
        ORDER BY r.table_key, r.tenant_key_text, r.row_key_text
      )
      FROM wystack_draft_row_changes r
      WHERE r.draft_id = ${draftId}
    ), '[]'::jsonb)
  )::text)`
}

const draftStorageVersion = 10
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
        WHERE table_schema = current_schema()
          AND table_name = 'wystack_draft_tables' AND column_name = 'shadow_tag'
      ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'wystack_draft_tables' AND column_name = 'invalidation_tag'
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

// Revisioned canonical rows retain an incarnation token after deletion. A
// later insert of the same stable scalar identity receives a new token, so CAS
// cannot mistake a replacement row for the base row a draft observed.
const storageDdlV5 = [
  sql.raw(`CREATE TABLE IF NOT EXISTS wystack_row_revisions (
    table_key TEXT NOT NULL,
    tenant_key_text TEXT NOT NULL DEFAULT '',
    row_key_text TEXT NOT NULL,
    revision INTEGER NOT NULL,
    PRIMARY KEY (table_key, tenant_key_text, row_key_text)
  )`),
  // A pre-v5 active draft has no durable identity reservation. Its old
  // base_revision cannot prove that a deleted row was not replaced before the
  // ledger existed, so force an explicit rebase instead of guessing a token.
  sql.raw(`UPDATE wystack_draft_row_changes d
    SET base_revision = '{"wystack":"rebase-required","reason":"revision-ledger-upgrade"}'::jsonb
    FROM wystack_draft_tables t
    WHERE t.draft_id = d.draft_id
      AND d.table_key = CASE WHEN t.schema_name = '' THEN t.table_name
        ELSE t.schema_name || '.' || t.table_name END
      AND t.revision_column IS NOT NULL`),
]

// The command log and reviewed row changes are one integrity-bound record. The
// log can reproduce intent while the materialized rows retain exact proposals
// and anchors; publish requires the two representations to agree.
const storageDdlV6 = [
  sql.raw(`ALTER TABLE wystack_drafts ADD COLUMN IF NOT EXISTS integrity_hash TEXT`),
  sql`UPDATE wystack_drafts d
    SET integrity_hash = ${draftIntegrityExpression(sql.raw('d.draft_id'), {
      includesSoftDeleteColumn: false,
    })}`,
  sql.raw(`ALTER TABLE wystack_drafts ALTER COLUMN integrity_hash SET NOT NULL`),
]

// Child writes happen before lifecycle hooks and the final parent-row CAS.
// Defer every FK to the draft row—including the duplicate named/unnamed
// row-change constraints created by older migrations—so those writes do not
// acquire a parent KEY SHARE lock while host callbacks are running.
const storageDdlV7 = [
  sql.raw(`DO $$
    DECLARE fk RECORD;
    BEGIN
      FOR fk IN
        SELECT n.nspname AS schema_name, c.relname AS table_name, con.conname
        FROM pg_catalog.pg_constraint con
        JOIN pg_catalog.pg_class c ON c.oid = con.conrelid
        JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
        WHERE con.contype = 'f'
          AND con.confrelid = 'wystack_drafts'::regclass
      LOOP
        EXECUTE format(
          'ALTER TABLE %I.%I ALTER CONSTRAINT %I DEFERRABLE INITIALLY DEFERRED',
          fk.schema_name, fk.table_name, fk.conname
        );
      END LOOP;
    END $$`),
]

// Custody values are arbitrary JSON and may be much larger than PostgreSQL's
// btree entry limit. Index fixed-size deterministic MD5 digests of PostgreSQL's
// canonical JSONB text, then retain exact JSONB predicates in every query as
// collision rechecks. The digest is an index-routing value, not a security
// primitive. created_at is the immutable keyset; updated_at remains display
// metadata only.
const storageDdlV8 = [
  sql.raw(`ALTER TABLE wystack_drafts ADD COLUMN IF NOT EXISTS lookup_key TEXT`),
  sql.raw(`ALTER TABLE wystack_drafts ADD COLUMN IF NOT EXISTS summary JSONB`),
  sql.raw(`UPDATE wystack_drafts
    SET summary = '{"present":false}'::jsonb
    WHERE summary IS NULL`),
  sql.raw(`ALTER TABLE wystack_drafts ALTER COLUMN summary SET NOT NULL`),
  sql.raw(`ALTER TABLE wystack_drafts ALTER COLUMN summary
    SET DEFAULT '{"present":false}'::jsonb`),
  sql.raw(`DO $$
    BEGIN
      ALTER TABLE wystack_drafts
        ADD CONSTRAINT wystack_drafts_lookup_key_size_check
        CHECK (
          lookup_key IS NULL OR
          octet_length(lookup_key) BETWEEN 1 AND ${MAX_DRAFT_LOOKUP_KEY_BYTES}
        );
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$`),
  sql.raw(`CREATE INDEX IF NOT EXISTS wystack_drafts_custody_created_idx
    ON wystack_drafts (
      md5(tenant_scope::text),
      md5(owner_key::text),
      created_at DESC,
      draft_id DESC
    )`),
  sql.raw(`CREATE INDEX IF NOT EXISTS wystack_drafts_custody_lookup_idx
    ON wystack_drafts (
      md5(tenant_scope::text),
      md5(owner_key::text),
      lookup_key,
      created_at DESC,
      draft_id DESC
    ) WHERE lookup_key IS NOT NULL`),
]

// Table capability snapshots make replay fail closed when a deployment changes
// whether an already-touched canonical relation is logically removable.
const storageDdlV9 = [
  sql.raw(`ALTER TABLE wystack_draft_tables
    ADD COLUMN IF NOT EXISTS soft_delete_column TEXT`),
  sql`UPDATE wystack_drafts d
    SET integrity_hash = ${draftIntegrityExpression(sql.raw('d.draft_id'))}`,
]

// v8 used PostgreSQL's internal jsonb_hash_extended implementation and
// CREATE INDEX IF NOT EXISTS, which could retain a same-named stale definition.
// Inspect the complete index shape and rebuild only definitions that differ
// from the stable digest contract. The migration ledger keeps this a one-time
// check; the guards also make the DDL itself safe to resume.
const storageDdlV10 = [
  sql.raw(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class index_relation
        JOIN pg_catalog.pg_namespace index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        WHERE index_namespace.nspname = current_schema()
          AND index_relation.relname = 'wystack_drafts_custody_created_idx'
      ) AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index index_entry
        JOIN pg_catalog.pg_class index_relation
          ON index_relation.oid = index_entry.indexrelid
        JOIN pg_catalog.pg_namespace index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        JOIN pg_catalog.pg_class table_relation
          ON table_relation.oid = index_entry.indrelid
        JOIN pg_catalog.pg_am access_method
          ON access_method.oid = index_relation.relam
        WHERE index_namespace.nspname = current_schema()
          AND index_relation.relname = 'wystack_drafts_custody_created_idx'
          AND table_relation.relname = 'wystack_drafts'
          AND access_method.amname = 'btree'
          AND index_entry.indisvalid
          AND index_entry.indisready
          AND NOT index_entry.indisunique
          AND index_entry.indnkeyatts = 4
          AND index_entry.indnatts = 4
          AND pg_get_indexdef(index_entry.indexrelid, 1, true) = 'md5(tenant_scope::text)'
          AND pg_get_indexdef(index_entry.indexrelid, 2, true) = 'md5(owner_key::text)'
          AND pg_get_indexdef(index_entry.indexrelid, 3, true) = 'created_at'
          AND pg_get_indexdef(index_entry.indexrelid, 4, true) = 'draft_id'
          AND pg_index_column_has_property(index_entry.indexrelid, 3, 'desc')
          AND pg_index_column_has_property(index_entry.indexrelid, 4, 'desc')
          AND index_entry.indpred IS NULL
      ) THEN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_index index_entry
          JOIN pg_catalog.pg_class index_relation
            ON index_relation.oid = index_entry.indexrelid
          JOIN pg_catalog.pg_namespace index_namespace
            ON index_namespace.oid = index_relation.relnamespace
          JOIN pg_catalog.pg_class table_relation
            ON table_relation.oid = index_entry.indrelid
          JOIN pg_catalog.pg_namespace table_namespace
            ON table_namespace.oid = table_relation.relnamespace
          WHERE index_namespace.nspname = current_schema()
            AND index_relation.relname = 'wystack_drafts_custody_created_idx'
            AND table_namespace.nspname = current_schema()
            AND table_relation.relname = 'wystack_drafts'
        ) THEN
          RAISE EXCEPTION
            'draft storage migration: reserved index name wystack_drafts_custody_created_idx belongs to another relation';
        END IF;
        EXECUTE format(
          'DROP INDEX %I.%I',
          current_schema(),
          'wystack_drafts_custody_created_idx'
        );
      END IF;
    END $$`),
  sql.raw(`CREATE INDEX IF NOT EXISTS wystack_drafts_custody_created_idx
    ON wystack_drafts (
      md5(tenant_scope::text),
      md5(owner_key::text),
      created_at DESC,
      draft_id DESC
    )`),
  sql.raw(`DO $$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class index_relation
        JOIN pg_catalog.pg_namespace index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        WHERE index_namespace.nspname = current_schema()
          AND index_relation.relname = 'wystack_drafts_custody_lookup_idx'
      ) AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index index_entry
        JOIN pg_catalog.pg_class index_relation
          ON index_relation.oid = index_entry.indexrelid
        JOIN pg_catalog.pg_namespace index_namespace
          ON index_namespace.oid = index_relation.relnamespace
        JOIN pg_catalog.pg_class table_relation
          ON table_relation.oid = index_entry.indrelid
        JOIN pg_catalog.pg_am access_method
          ON access_method.oid = index_relation.relam
        WHERE index_namespace.nspname = current_schema()
          AND index_relation.relname = 'wystack_drafts_custody_lookup_idx'
          AND table_relation.relname = 'wystack_drafts'
          AND access_method.amname = 'btree'
          AND index_entry.indisvalid
          AND index_entry.indisready
          AND NOT index_entry.indisunique
          AND index_entry.indnkeyatts = 5
          AND index_entry.indnatts = 5
          AND pg_get_indexdef(index_entry.indexrelid, 1, true) = 'md5(tenant_scope::text)'
          AND pg_get_indexdef(index_entry.indexrelid, 2, true) = 'md5(owner_key::text)'
          AND pg_get_indexdef(index_entry.indexrelid, 3, true) = 'lookup_key'
          AND pg_get_indexdef(index_entry.indexrelid, 4, true) = 'created_at'
          AND pg_get_indexdef(index_entry.indexrelid, 5, true) = 'draft_id'
          AND pg_index_column_has_property(index_entry.indexrelid, 4, 'desc')
          AND pg_index_column_has_property(index_entry.indexrelid, 5, 'desc')
          AND pg_get_expr(index_entry.indpred, index_entry.indrelid, true) =
            'lookup_key IS NOT NULL'
      ) THEN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_catalog.pg_index index_entry
          JOIN pg_catalog.pg_class index_relation
            ON index_relation.oid = index_entry.indexrelid
          JOIN pg_catalog.pg_namespace index_namespace
            ON index_namespace.oid = index_relation.relnamespace
          JOIN pg_catalog.pg_class table_relation
            ON table_relation.oid = index_entry.indrelid
          JOIN pg_catalog.pg_namespace table_namespace
            ON table_namespace.oid = table_relation.relnamespace
          WHERE index_namespace.nspname = current_schema()
            AND index_relation.relname = 'wystack_drafts_custody_lookup_idx'
            AND table_namespace.nspname = current_schema()
            AND table_relation.relname = 'wystack_drafts'
        ) THEN
          RAISE EXCEPTION
            'draft storage migration: reserved index name wystack_drafts_custody_lookup_idx belongs to another relation';
        END IF;
        EXECUTE format(
          'DROP INDEX %I.%I',
          current_schema(),
          'wystack_drafts_custody_lookup_idx'
        );
      END IF;
    END $$`),
  sql.raw(`CREATE INDEX IF NOT EXISTS wystack_drafts_custody_lookup_idx
    ON wystack_drafts (
      md5(tenant_scope::text),
      md5(owner_key::text),
      lookup_key,
      created_at DESC,
      draft_id DESC
    ) WHERE lookup_key IS NOT NULL`),
]

export async function ensureDraftStorage(raw: RawDb): Promise<void> {
  await withFrameworkBootstrapLock(raw, async (tx: RawDb) => {
    await tx.execute(migrationTableDdl)
    await tx.execute(sql`
      INSERT INTO wystack_framework_migrations (migration_name, version)
      VALUES ('draft-storage', 0)
      ON CONFLICT (migration_name) DO NOTHING
    `)
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
    if (installedVersion < 5) {
      for (const statement of storageDdlV5) await tx.execute(statement)
    }
    if (installedVersion < 6) {
      for (const statement of storageDdlV6) await tx.execute(statement)
    }
    if (installedVersion < 7) {
      for (const statement of storageDdlV7) await tx.execute(statement)
    }
    if (installedVersion < 8) {
      for (const statement of storageDdlV8) await tx.execute(statement)
    }
    if (installedVersion < 9) {
      for (const statement of storageDdlV9) await tx.execute(statement)
    }
    if (installedVersion < 10) {
      for (const statement of storageDdlV10) await tx.execute(statement)
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
  const lookupKey =
    draft.lookupKey === undefined ? undefined : validateDraftLookupKey(draft.lookupKey)
  const summarySnapshot =
    draft.summary === undefined ? undefined : snapshotDraftSummary(draft.summary)
  const summary = encodeEnvelope(summarySnapshot, 'draft summary')
  const integrityHash = draftIntegrityExpression(sql`${draft.draftId}`)
  await raw.execute(sql`
    INSERT INTO wystack_drafts
      (draft_id, base_version, tenant_scope, owner_key, lookup_key, summary,
       log_revision, integrity_hash)
    VALUES
      (${draft.draftId}, ${baseVersion}::jsonb, ${tenantScope}::jsonb, ${ownerKey}::jsonb,
       ${lookupKey ?? null}, ${summary}::jsonb, 0, ${integrityHash})
  `)
}

export async function readStoredDraft(
  raw: RawDb,
  draftId: string,
): Promise<StoredDraft | undefined> {
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT draft_id, base_version, tenant_scope, owner_key, lookup_key, summary, log_revision
      FROM wystack_drafts
      WHERE draft_id = ${draftId}
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
    lookupKey: row['lookup_key'] == null ? undefined : String(row['lookup_key']),
    summary: decodeEnvelope(row['summary']) as DraftSummary | undefined,
  }
}

/**
 * Lock the draft row while its command rows are read. Mutations update this row
 * last, so the returned revision and subsequent command read belong to one
 * committed log state even when an append is already in flight.
 */
export async function readStoredDraftForLogSnapshot(
  raw: RawDb,
  draftId: string,
): Promise<StoredDraft | undefined> {
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT draft_id, base_version, tenant_scope, owner_key, lookup_key, summary, log_revision
      FROM wystack_drafts
      WHERE draft_id = ${draftId}
      FOR SHARE
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
    lookupKey: row['lookup_key'] == null ? undefined : String(row['lookup_key']),
    summary: decodeEnvelope(row['summary']) as DraftSummary | undefined,
  }
}

export async function listStoredDraftsForOwner(
  raw: RawDb,
  tenantId: unknown,
  ownerKey: unknown,
  opts: ListStoredDraftsForOwnerOptions = {},
): Promise<StoredDraftSummary[]> {
  const limit = normalizeOwnedDraftPageSize(opts.limit)
  const cursor = normalizeOwnedDraftCursor(opts.cursor)
  const tenantScope = encodeEnvelope(tenantId, 'tenant scope')
  const encodedOwnerKey = encodeEnvelope(ownerKey, 'owner key')
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT draft_id, base_version, lookup_key, summary,
             to_char(
               created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS created_at_cursor,
             to_char(
               updated_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS updated_at_display
      FROM wystack_drafts
      WHERE md5(tenant_scope::text) = md5((${tenantScope}::jsonb)::text)
        AND md5(owner_key::text) = md5((${encodedOwnerKey}::jsonb)::text)
        AND tenant_scope = ${tenantScope}::jsonb
        AND owner_key = ${encodedOwnerKey}::jsonb
        ${
          cursor
            ? sql`AND (created_at, draft_id) <
                (${cursor.createdAt}::timestamptz, ${cursor.draftId})`
            : sql``
        }
      ORDER BY created_at DESC, draft_id DESC
      LIMIT ${limit}
    `),
  )
  return rows.map(storedDraftSummaryFromRow)
}

export async function findStoredDraftForOwnerByLookupKey(
  raw: RawDb,
  tenantId: unknown,
  ownerKey: unknown,
  lookupKey: string,
): Promise<StoredDraftSummary | undefined> {
  const normalizedLookupKey = validateDraftLookupKey(lookupKey)
  const tenantScope = encodeEnvelope(tenantId, 'tenant scope')
  const encodedOwnerKey = encodeEnvelope(ownerKey, 'owner key')
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT draft_id, base_version, lookup_key, summary,
             to_char(
               created_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS created_at_cursor,
             to_char(
               updated_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) AS updated_at_display
      FROM wystack_drafts
      WHERE md5(tenant_scope::text) = md5((${tenantScope}::jsonb)::text)
        AND md5(owner_key::text) = md5((${encodedOwnerKey}::jsonb)::text)
        AND tenant_scope = ${tenantScope}::jsonb
        AND owner_key = ${encodedOwnerKey}::jsonb
        AND lookup_key = ${normalizedLookupKey}
      ORDER BY created_at DESC, draft_id DESC
      LIMIT 1
    `),
  )
  return rows[0] ? storedDraftSummaryFromRow(rows[0]) : undefined
}

/**
 * Serialize owned lookup-key initializers across connections. Hash collisions
 * only add contention: callers must still perform the exact JSONB custody query
 * after acquiring this transaction-scoped lock.
 */
export async function lockStoredDraftLookup(
  raw: RawDb,
  tenantId: unknown,
  ownerKey: unknown,
  lookupKey: string,
): Promise<void> {
  const normalizedLookupKey = validateDraftLookupKey(lookupKey)
  const tenantScope = encodeEnvelope(tenantId, 'tenant scope')
  const encodedOwnerKey = encodeEnvelope(ownerKey, 'owner key')
  await raw.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext('wystack owned draft lookup'),
      hashtext(
        jsonb_hash_extended(${tenantScope}::jsonb, 0)::text || ':' ||
        jsonb_hash_extended(${encodedOwnerKey}::jsonb, 0)::text || ':' ||
        ${normalizedLookupKey}
      )
    )
  `)
}

function storedDraftSummaryFromRow(row: Record<string, unknown>): StoredDraftSummary {
  const draftId = String(row['draft_id'])
  const createdAt = String(row['created_at_cursor'])
  return {
    draftId,
    baseVersion: decodeEnvelope(row['base_version']),
    createdAt,
    updatedAt: String(row['updated_at_display']),
    lookupKey: row['lookup_key'] == null ? undefined : String(row['lookup_key']),
    summary: decodeEnvelope(row['summary']) as DraftSummary | undefined,
    cursor: { createdAt, draftId },
  }
}

function normalizeOwnedDraftPageSize(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_OWNED_DRAFT_PAGE_SIZE
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new Error('draft lifecycle: owned draft page size must be a positive safe integer')
  }
  if (resolved > MAX_OWNED_DRAFT_PAGE_SIZE) {
    throw new Error(
      `draft lifecycle: owned draft page size must not exceed ${MAX_OWNED_DRAFT_PAGE_SIZE}`,
    )
  }
  return resolved
}

function normalizeOwnedDraftCursor(cursor: OwnedDraftCursor | undefined): OwnedDraftCursor | null {
  if (cursor === undefined) return null
  if (
    !cursor ||
    typeof cursor !== 'object' ||
    typeof cursor.createdAt !== 'string' ||
    !isOwnedDraftCursorTimestamp(cursor.createdAt) ||
    typeof cursor.draftId !== 'string' ||
    cursor.draftId.length === 0
  ) {
    throw new Error('draft lifecycle: owned draft cursor is invalid')
  }
  return cursor
}

const ownedDraftCursorTimestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/

function isOwnedDraftCursorTimestamp(value: string): boolean {
  const match = ownedDraftCursorTimestampPattern.exec(value)
  if (!match) return false
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, microseconds] = match
  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const hour = Number(hourText)
  const minute = Number(minuteText)
  const second = Number(secondText)
  const millisecond = Number(microseconds?.slice(0, 3))
  // PostgreSQL has no year zero, so the storage emitter can never produce it.
  if (year === 0) return false
  const timestamp = new Date(0)
  timestamp.setUTCFullYear(year, month - 1, day)
  timestamp.setUTCHours(hour, minute, second, millisecond)
  return (
    timestamp.getUTCFullYear() === year &&
    timestamp.getUTCMonth() === month - 1 &&
    timestamp.getUTCDate() === day &&
    timestamp.getUTCHours() === hour &&
    timestamp.getUTCMinutes() === minute &&
    timestamp.getUTCSeconds() === second &&
    timestamp.getUTCMilliseconds() === millisecond
  )
}

export function validateDraftLookupKey(lookupKey: string): string {
  if (typeof lookupKey !== 'string' || lookupKey.length === 0 || lookupKey.includes('\0')) {
    throw new Error('draft lifecycle: lookup key must be non-empty text without NUL bytes')
  }
  const byteLength = new TextEncoder().encode(lookupKey).byteLength
  if (byteLength > MAX_DRAFT_LOOKUP_KEY_BYTES) {
    throw new Error(
      `draft lifecycle: lookup key must not exceed ${MAX_DRAFT_LOOKUP_KEY_BYTES} UTF-8 bytes`,
    )
  }
  return lookupKey
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
  for (let position = 0; position < commands.length; position++) {
    const command = encodeJson(commands[position], 'draft command')
    await raw.execute(sql`
      INSERT INTO wystack_draft_commands (draft_id, position, command)
      VALUES (${draftId}, ${position}, ${command}::jsonb)
      ON CONFLICT (draft_id, position)
      DO UPDATE SET command = EXCLUDED.command
    `)
  }
  await raw.execute(sql`
    DELETE FROM wystack_draft_commands
    WHERE draft_id = ${draftId} AND position >= ${commands.length}
  `)
}

export async function assertStoredDraftIntegrity(raw: RawDb, draftId: string): Promise<void> {
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT integrity_hash,
             ${draftIntegrityExpression(sql.raw('d.draft_id'))} AS current_integrity_hash
      FROM wystack_drafts d
      WHERE d.draft_id = ${draftId}
    `),
  )
  const row = rows[0]
  if (!row || row['integrity_hash'] !== row['current_integrity_hash']) {
    throw new DraftIntegrityError(draftId)
  }
}

export async function refreshStoredDraftIntegrity(raw: RawDb, draftId: string): Promise<void> {
  const rows = normalizeRows(
    await raw.execute(sql`
      UPDATE wystack_drafts d
      SET integrity_hash = ${draftIntegrityExpression(sql.raw('d.draft_id'))}
      WHERE d.draft_id = ${draftId}
      RETURNING integrity_hash
    `),
  )
  if (rows.length !== 1) {
    throw new Error(`draft lifecycle: unknown draft "${draftId}"`)
  }
}

export async function refreshStoredDraftIntegrityAndAdvance(
  raw: RawDb,
  draftId: string,
  expectedRevision: number,
  metadata: StoredDraftMetadataUpdate = {},
): Promise<void> {
  const replacesSummary = Object.hasOwn(metadata, 'summary')
  const summary = replacesSummary
    ? encodeEnvelope(snapshotDraftSummary(metadata.summary), 'draft summary')
    : undefined
  const rows = normalizeRows(
    await raw.execute(sql`
      UPDATE wystack_drafts d
      SET integrity_hash = ${draftIntegrityExpression(sql.raw('d.draft_id'))},
          log_revision = log_revision + 1,
          updated_at = CURRENT_TIMESTAMP
          ${replacesSummary ? sql`, summary = ${summary}::jsonb` : sql``}
      WHERE d.draft_id = ${draftId} AND d.log_revision = ${expectedRevision}
      RETURNING log_revision
    `),
  )
  if (rows.length !== 1) throw new StoredDraftRevisionChangedError(draftId)
}

export class StoredDraftRevisionChangedError extends Error {
  constructor(draftId: string) {
    super(`draft lifecycle: draft "${draftId}" changed concurrently`)
    this.name = 'StoredDraftRevisionChangedError'
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
         tenant_column, tenant_type, revision_column, soft_delete_column, invalidation_tag)
      VALUES
        (${draftId}, ${table.schema ?? ''}, ${table.table}, ${table.pkColumn}, ${table.pkType},
         ${table.tenantColumn ?? null}, ${table.tenantType ?? null},
         ${table.revisionColumn ?? null}, ${table.softDeleteColumn ?? null},
         ${table.invalidationTag ?? null})
      ON CONFLICT (draft_id, schema_name, table_name)
      DO UPDATE SET
        pk_column = EXCLUDED.pk_column,
        pk_type = EXCLUDED.pk_type,
        tenant_column = EXCLUDED.tenant_column,
        tenant_type = EXCLUDED.tenant_type,
        revision_column = EXCLUDED.revision_column,
        soft_delete_column = EXCLUDED.soft_delete_column,
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
             tenant_column, tenant_type, revision_column, soft_delete_column, invalidation_tag
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
    softDeleteColumn:
      row['soft_delete_column'] == null ? undefined : String(row['soft_delete_column']),
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
      UPDATE wystack_drafts d
      SET base_version = ${encoded}::jsonb,
          integrity_hash = ${draftIntegrityExpression(sql.raw('d.draft_id'))},
          log_revision = log_revision + 1,
          updated_at = CURRENT_TIMESTAMP
      WHERE d.draft_id = ${draftId} AND d.log_revision = ${expectedRevision}
      RETURNING log_revision
    `),
  )
  if (rows.length !== 1) {
    throw new StoredDraftRevisionChangedError(draftId)
  }
}

export async function deleteStoredTouchedTables(raw: RawDb, draftId: string): Promise<void> {
  await raw.execute(sql`DELETE FROM wystack_draft_tables WHERE draft_id = ${draftId}`)
}

export async function deleteStoredCommands(raw: RawDb, draftId: string): Promise<void> {
  await raw.execute(sql`DELETE FROM wystack_draft_commands WHERE draft_id = ${draftId}`)
}

export async function deleteStoredDraftAtRevision(
  raw: RawDb,
  draftId: string,
  expectedRevision: number,
): Promise<boolean> {
  const rows = normalizeRows(
    await raw.execute(sql`
      DELETE FROM wystack_drafts
      WHERE draft_id = ${draftId} AND log_revision = ${expectedRevision}
      RETURNING draft_id
    `),
  )
  return rows.length === 1
}

function encodeEnvelope(value: unknown, label: string): string {
  return encodeJson({ present: value !== undefined, value }, label)
}

function decodeEnvelope(value: unknown): unknown {
  const envelope = decodeJsonColumn(value) as {
    present?: boolean
    value?: unknown
  }
  return envelope.present ? envelope.value : undefined
}

function encodeJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new TypeError('value is not JSON-serializable')
    return encoded
  } catch (cause) {
    throw new Error(`draft lifecycle: ${label} must be JSON-serializable`, {
      cause,
    })
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
