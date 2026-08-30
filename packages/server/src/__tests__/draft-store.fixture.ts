import { drizzle } from 'drizzle-orm/pglite'

type DraftStoreTestDatabase = ReturnType<typeof drizzle>

async function installMigrationLedger(db: DraftStoreTestDatabase, version: number): Promise<void> {
  await db.execute(`CREATE TABLE wystack_framework_migrations (
    migration_name TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  await db.execute(
    `INSERT INTO wystack_framework_migrations (migration_name, version)
     VALUES ('draft-storage', ${version})`,
  )
}

/** Materialize the v7 parent relation needed to exercise the v8 custody-index upgrade. */
export async function installV7CustodyUpgradeFixture(db: DraftStoreTestDatabase): Promise<void> {
  await installMigrationLedger(db, 7)
  await db.execute(`CREATE TABLE wystack_drafts (
    draft_id TEXT PRIMARY KEY,
    base_version JSONB NOT NULL,
    tenant_scope JSONB NOT NULL,
    owner_key JSONB NOT NULL,
    log_revision INTEGER NOT NULL DEFAULT 0,
    integrity_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
}

/** Materialize the minimal v2-era relations needed to exercise later metadata repair. */
export async function installV2MetadataUpgradeFixture(db: DraftStoreTestDatabase): Promise<void> {
  await installMigrationLedger(db, 2)
  await db.execute(`CREATE TABLE wystack_drafts (
    draft_id TEXT PRIMARY KEY, base_version JSONB NOT NULL, tenant_scope JSONB NOT NULL,
    owner_key JSONB NOT NULL, log_revision INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`)
  await db.execute(`CREATE TABLE wystack_draft_commands (
    draft_id TEXT NOT NULL REFERENCES wystack_drafts(draft_id) ON DELETE CASCADE,
    position INTEGER NOT NULL, command JSONB NOT NULL, PRIMARY KEY (draft_id, position)
  )`)
  await db.execute(`CREATE TABLE wystack_draft_tables (
    draft_id TEXT NOT NULL REFERENCES wystack_drafts(draft_id) ON DELETE CASCADE,
    schema_name TEXT NOT NULL DEFAULT '', table_name TEXT NOT NULL,
    pk_column TEXT NOT NULL, shadow_tag TEXT,
    PRIMARY KEY (draft_id, schema_name, table_name)
  )`)
  await db.execute(`CREATE TABLE wystack_draft_row_changes (
    draft_id TEXT NOT NULL, table_key TEXT NOT NULL,
    tenant_key_text TEXT NOT NULL DEFAULT '', tenant_key JSONB,
    row_key_text TEXT NOT NULL, row_key JSONB NOT NULL, operation TEXT NOT NULL,
    base_exists BOOLEAN NOT NULL, base_revision JSONB, fields JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (draft_id, table_key, tenant_key_text, row_key_text)
  )`)
}
