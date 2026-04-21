import { describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import {
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core'

import { renderCreateTableIfNotExists, syncSchema } from '../sync'

const bytea = customType<{ data: Uint8Array; default: false }>({
  dataType() {
    return 'bytea'
  },
})

describe('renderCreateTableIfNotExists', () => {
  test('emits columns with types, NOT NULL, PK, and default expressions', () => {
    const users = pgTable('users', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    })

    const ddl = renderCreateTableIfNotExists(users)
    expect(ddl).toContain('CREATE TABLE IF NOT EXISTS "users"')
    expect(ddl).toContain('"id" uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY')
    expect(ddl).toContain('"name" text NOT NULL')
    expect(ddl).toContain('"created_at" timestamp with time zone NOT NULL DEFAULT now()')
  })

  test('emits FK with ON DELETE cascade', () => {
    const parent = pgTable('parent', { id: uuid('id').primaryKey() })
    const child = pgTable('child', {
      id: uuid('id').primaryKey(),
      parentId: uuid('parent_id')
        .notNull()
        .references(() => parent.id, { onDelete: 'cascade' }),
    })

    const ddl = renderCreateTableIfNotExists(child)
    expect(ddl).toContain('FOREIGN KEY ("parent_id") REFERENCES "parent" ("id")')
    expect(ddl).toContain('ON DELETE CASCADE')
  })

  test('emits table-level composite UNIQUE with declared name', () => {
    const t = pgTable(
      'secrets',
      {
        sourceId: uuid('source_id').notNull(),
        secretName: text('secret_name').notNull(),
        ciphertext: bytea('ciphertext').notNull(),
      },
      (tbl) => [unique('secrets_source_name_unique').on(tbl.sourceId, tbl.secretName)],
    )

    const ddl = renderCreateTableIfNotExists(t)
    expect(ddl).toContain('CONSTRAINT "secrets_source_name_unique" UNIQUE ("source_id", "secret_name")')
    expect(ddl).toContain('"ciphertext" bytea NOT NULL')
  })
})

describe('syncSchema', () => {
  test('creates all tables in dependency order', async () => {
    const insights = pgTable('insights', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    })
    const visualizations = pgTable('visualizations', {
      id: uuid('id').primaryKey().defaultRandom(),
      insightId: uuid('insight_id')
        .notNull()
        .references(() => insights.id, { onDelete: 'cascade' }),
      chartType: text('chart_type').notNull(),
    })

    const client = new PGlite()
    await client.waitReady
    const db = drizzle(client)

    // Declare visualizations first to verify the sort promotes insights ahead.
    await syncSchema(db, { visualizations, insights })

    await db.insert(insights).values({ name: 'weekly sales' })
    await db.insert(visualizations).values({
      insightId: (await db.select().from(insights))[0]!.id,
      chartType: 'bar',
    })

    const rows = await db.select().from(visualizations)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.chartType).toBe('bar')
  })

  test('is idempotent across repeated invocations', async () => {
    const simple = pgTable('simple', {
      id: uuid('id').primaryKey().defaultRandom(),
      payload: jsonb('payload').notNull(),
    })
    const client = new PGlite()
    await client.waitReady
    const db = drizzle(client)

    await syncSchema(db, { simple })
    await syncSchema(db, { simple })

    await db.insert(simple).values({ payload: { ok: true } })
    expect(await db.select().from(simple)).toHaveLength(1)
  })

  test('enforces cascade delete on a FK with onDelete: cascade', async () => {
    const parent = pgTable('parent', {
      id: uuid('id').primaryKey().defaultRandom(),
      name: text('name').notNull(),
    })
    const child = pgTable('child', {
      id: uuid('id').primaryKey().defaultRandom(),
      parentId: uuid('parent_id')
        .notNull()
        .references(() => parent.id, { onDelete: 'cascade' }),
      counter: integer('counter').notNull(),
    })

    const client = new PGlite()
    await client.waitReady
    const db = drizzle(client)
    await syncSchema(db, { parent, child })

    const [p] = await db.insert(parent).values({ name: 'p' }).returning()
    await db.insert(child).values({ parentId: p!.id, counter: 1 })

    expect(await db.select().from(child)).toHaveLength(1)

    await db.delete(parent)

    expect(await db.select().from(child)).toHaveLength(0)
  })
})
