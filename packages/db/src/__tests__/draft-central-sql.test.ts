import { beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { integer, jsonb, pgSchema, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'
import { createDrizzleTracker, draftJsonNull, enumerateDraftRowChanges } from '../drizzle-tracker'
import { eq, gt, lt } from '../operators'
import { defineSchema } from '../schema'
import { int, text as dslText } from '../dsl'
import { multiTenant } from '../table'
import { syncSchema } from '../sync'

const items = pgTable('draft_items', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  score: integer('score').notNull(),
  note: text('note'),
  payload: jsonb('payload'),
})

const defaultedItems = pgTable('draft_defaulted_items', {
  id: integer('id').primaryKey(),
  label: text('label').notNull().default('new'),
})

const dynamicDefaultItems = pgTable('draft_dynamic_default_items', {
  id: integer('id').primaryKey(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

const audit = pgSchema('draft_audit')
const auditItems = audit.table('draft_items', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

const tenancy = multiTenant({
  key: { property: 'tenantId', column: 'tenant_id', type: dslText },
})
const tenantSchema = defineSchema({
  tenant_items: tenancy.table({ id: int.primaryKey(), title: dslText, score: int }).draftable(),
})

let pg: PGlite
let db: ReturnType<typeof drizzle>
let tracked: ReturnType<typeof createDrizzleTracker>

beforeEach(async () => {
  pg = new PGlite()
  db = drizzle(pg)
  const setup = [
    `CREATE TABLE draft_items (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      score INTEGER NOT NULL,
      note TEXT,
      payload JSONB
    )`,
    `CREATE TABLE draft_defaulted_items (
      id INTEGER PRIMARY KEY,
      label TEXT NOT NULL DEFAULT 'new'
    )`,
    `CREATE TABLE draft_dynamic_default_items (
      id INTEGER PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE SCHEMA draft_audit`,
    `CREATE TABLE draft_audit.draft_items (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL
    )`,
    `CREATE TABLE wystack_draft_row_changes (
      draft_id TEXT NOT NULL,
      table_key TEXT NOT NULL,
      tenant_key_text TEXT NOT NULL DEFAULT '',
      tenant_key JSONB,
      row_key_text TEXT NOT NULL,
      row_key JSONB NOT NULL,
      operation TEXT NOT NULL,
      base_exists BOOLEAN NOT NULL,
      base_revision JSONB,
      fields JSONB NOT NULL DEFAULT '{}'::jsonb,
      PRIMARY KEY (draft_id, table_key, tenant_key_text, row_key_text)
    )`,
    `INSERT INTO draft_items (id, title, score, note, payload) VALUES
      (1, 'apple', 10, 'original note', '{"nested":true}'),
      (2, 'banana', 20, NULL, 'null'::jsonb),
      (3, 'cherry', 30, 'third', NULL),
      (4, 'date', 40, 'fourth', '{}')`,
    `INSERT INTO draft_audit.draft_items (id, title) VALUES (1, 'audit apple')`,
  ]
  for (const statement of setup) await db.execute(sql.raw(statement))
  await syncSchema(db, tenantSchema)
  tracked = createDrizzleTracker(db)
})

describe('durable central draft overlay', () => {
  test('keeps immutable first-touch original across A to B to C and distinguishes null states', async () => {
    const draft = tracked.withDraft('d-null')

    expect(await draft.from(items).where(eq('id', 1)).update({ note: undefined })).toEqual([])
    await draft.from(items).where(eq('id', 1)).update({ title: 'B', note: null })
    await draft.from(items).where(eq('id', 1)).update({ title: 'C' })
    await draft.from(items).where(eq('id', 1)).update({ payload: draftJsonNull() })

    const effective = await draft.from(items).where(eq('id', 1)).first()
    expect(effective).toEqual({ id: 1, title: 'C', score: 10, note: null, payload: null })

    const changes = await enumerateDraftRowChanges(db, 'd-null')
    expect(changes).toHaveLength(1)
    expect(changes[0]?.fields['title']).toEqual({
      original: { kind: 'value', value: 'apple' },
      value: { kind: 'value', value: 'C' },
    })
    expect(changes[0]?.fields['note']).toEqual({
      original: { kind: 'value', value: 'original note' },
      value: { kind: 'sql-null' },
    })
    expect(changes[0]?.fields['payload']?.value).toEqual({ kind: 'json', value: null })
  })

  test('preserves database-native filters and ordered limited prefixes after rows cross boundaries', async () => {
    const draft = tracked.withDraft('d-filter')
    await draft.from(items).where(eq('id', 1)).update({ score: 35 })
    await draft.from(items).where(eq('id', 4)).update({ score: 15 })

    const rows = await draft
      .from(items)
      .where(gt('score', 18))
      .where(lt('score', 40))
      .orderBy('score', 'desc')
      .limit(2)
      .all()

    expect(rows.map((row) => [row.id, row.score])).toEqual([
      [1, 35],
      [3, 30],
    ])
  })

  test('represents inserts and deletes while leaving canonical untouched', async () => {
    const draft = tracked.withDraft('d-ops')
    await draft.into(items).insert({ id: 5, title: 'elderberry', score: 50 })
    await draft.from(items).where(eq('id', 2)).delete()

    expect((await draft.from(items).all()).map((row) => row.id)).toEqual([1, 3, 4, 5])
    expect((await tracked.from(items).all()).map((row) => row.id)).toEqual([1, 2, 3, 4])
    expect((await enumerateDraftRowChanges(db, 'd-ops')).map((change) => change.operation)).toEqual(
      ['delete', 'insert'],
    )
  })

  test('materializes database defaults in a draft insert', async () => {
    const draft = tracked.withDraft('d-default')

    expect(await draft.into(defaultedItems).insert({ id: 1 })).toEqual([{ id: 1, label: 'new' }])
    expect(await draft.from(defaultedItems).where(eq('label', 'new')).all()).toEqual([
      { id: 1, label: 'new' },
    ])
    expect(await tracked.from(defaultedItems).all()).toEqual([])

    expect(await tracked.into(defaultedItems).insert({ id: 2 })).toEqual([{ id: 2, label: 'new' }])
  })

  test('rejects omitted dynamic defaults that would change when the command is replayed', async () => {
    const draft = tracked.withDraft('d-dynamic-default')

    await expect(draft.into(dynamicDefaultItems).insert({ id: 1 })).rejects.toThrow(
      'resolve it into the command input',
    )
    expect(await enumerateDraftRowChanges(db, 'd-dynamic-default')).toEqual([])
  })

  test('updates a newly drafted row through the same effective filter path', async () => {
    const draft = tracked.withDraft('d-new-update')
    await draft.into(items).insert({ id: 5, title: 'elderberry', score: 50 })

    const updated = await draft.from(items).where(eq('title', 'elderberry')).update({ score: 55 })

    expect(updated).toEqual([{ id: 5, title: 'elderberry', score: 55, note: null, payload: null }])
    expect((await draft.from(items).where(eq('id', 5)).first())?.score).toBe(55)
    expect(await tracked.from(items).where(eq('id', 5)).first()).toBeNull()
  })

  test('schema-qualified table keys isolate same-named tables', async () => {
    const draft = tracked.withDraft('d-schema')
    await draft.from(items).where(eq('id', 1)).update({ title: 'public changed' })
    await draft.from(auditItems).where(eq('id', 1)).update({ title: 'audit changed' })

    expect((await draft.from(items).first())?.title).toBe('public changed')
    expect((await draft.from(auditItems).first())?.title).toBe('audit changed')
    expect(
      (await enumerateDraftRowChanges(db, 'd-schema')).map((change) => change.tableKey),
    ).toEqual(['draft_audit.draft_items', 'draft_items'])
  })

  test('point lookup lowering pins both canonical PK and central composite key', () => {
    const lowered = tracked.withDraft('d-point').from(items).where(eq('id', 3)).toSql()
    expect(lowered.sql).toContain('FROM (SELECT * FROM "draft_items" WHERE "id" =')
    expect(lowered.sql).toContain('"row_key_text" =')
    expect(lowered.params).toContain('3')
  })

  test('stores canonical scalar identity text instead of serialized documents', async () => {
    await tracked.withDraft('d-key').from(items).where(eq('id', 3)).update({ title: 'changed' })
    const result = await db.execute(
      sql`SELECT row_key_text FROM wystack_draft_row_changes WHERE draft_id = 'd-key'`,
    )
    // oxlint-disable-next-line typescript/no-explicit-any -- PGlite execute result wrapper
    expect((result as any).rows[0].row_key_text).toBe('3')
  })

  test('typed tenant keys isolate one draft ID across tenants, and a fresh tracker restores state', async () => {
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')
    await alpha.into(tenantSchema.tenant_items).insert({ id: 1, title: 'alpha', score: 1 })
    await beta.into(tenantSchema.tenant_items).insert({ id: 2, title: 'beta', score: 2 })
    const alphaUpdated = await alpha
      .withDraft('shared-id')
      .from(tenantSchema.tenant_items)
      .where(eq('id', 1))
      .update({ title: 'alpha draft' })
    const betaUpdated = await beta
      .withDraft('shared-id')
      .from(tenantSchema.tenant_items)
      .where(eq('id', 2))
      .update({ title: 'beta draft' })

    const restarted = createDrizzleTracker(db)
    expect(alphaUpdated).toHaveLength(1)
    expect(betaUpdated).toHaveLength(1)
    expect(
      (
        await restarted
          .withTenant('alpha')
          .withDraft('shared-id')
          .from(tenantSchema.tenant_items)
          .first()
      )?.title,
    ).toBe('alpha draft')
    expect(
      (
        await restarted
          .withTenant('beta')
          .withDraft('shared-id')
          .from(tenantSchema.tenant_items)
          .first()
      )?.title,
    ).toBe('beta draft')

    const changes = await enumerateDraftRowChanges(db, 'shared-id')
    expect(changes.map((change) => change.tenantKey)).toEqual([
      { type: 'text', value: 'alpha' },
      { type: 'text', value: 'beta' },
    ])
  })
})
