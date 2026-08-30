import { afterEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import {
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text as pgText,
  unique,
} from 'drizzle-orm/pg-core'
import {
  adoptSchema,
  createDrizzleTracker,
  eq,
  getTableCapabilities,
  multiTenant,
  syncSchema,
  text,
} from '../index'

const tenancy = multiTenant({
  key: { property: 'workspaceId', column: 'workspace_id', type: text },
})

function tenantTable(name: string) {
  return pgTable(
    name,
    {
      workspaceId: pgText('workspace_id').notNull(),
      id: pgText('id').notNull(),
      value: pgText('value').notNull(),
      rowRevision: integer('row_revision').notNull().default(1),
    },
    (row) => [primaryKey({ columns: [row.workspaceId, row.id] })],
  )
}

let client: PGlite | undefined

afterEach(async () => {
  await client?.close()
  client = undefined
})

describe('adoptSchema', () => {
  test('adds native tenant and draft custody to the authoritative Drizzle table', async () => {
    const records = tenantTable('adopted_records')
    const schema = adoptSchema(tenancy, {
      records: {
        table: records,
        logicalPrimaryKey: 'id',
        draftable: true,
        revisionProperty: 'rowRevision',
      },
    })

    expect(schema.records as unknown).toBe(records as unknown)
    expect(getTableCapabilities(records)).toMatchObject({
      draftable: true,
      revisionProperty: 'rowRevision',
      tenancy: { property: 'workspaceId', column: 'workspace_id' },
    })

    client = new PGlite()
    const db = drizzle(client)
    await syncSchema(db, schema)
    const tracked = createDrizzleTracker(db)
    const alpha = tracked.withTenant('alpha')
    const beta = tracked.withTenant('beta')

    await alpha.into(schema.records).insert({ id: 'shared', value: 'alpha' })
    await beta.into(schema.records).insert({ id: 'shared', value: 'beta' })
    await alpha.from(schema.records).where(eq('id', 'shared')).update({ value: 'alpha updated' })

    expect({
      alpha: await alpha.from(schema.records).where(eq('id', 'shared')).first(),
      beta: (await beta.from(schema.records).where(eq('id', 'shared')).first())?.value,
    }).toMatchObject({
      alpha: { value: 'alpha updated', rowRevision: 2 },
      beta: 'beta',
    })
  })

  test('rejects a tenant table whose physical identity is still global', () => {
    const records = pgTable('global_records', {
      workspaceId: pgText('workspace_id').notNull(),
      id: pgText('id').primaryKey(),
    })

    expect(() =>
      adoptSchema(tenancy, {
        records: { table: records, logicalPrimaryKey: 'id' },
      }),
    ).toThrow('must use the composite primary key (workspace_id, id)')
  })

  test('makes a globally keyed table an explicit expand-contract compatibility state', () => {
    const records = pgTable(
      'compatible_records',
      {
        workspaceId: pgText('workspace_id').notNull(),
        id: pgText('id').primaryKey(),
      },
      (row) => [unique('compatible_records_workspace_id_id_uq').on(row.workspaceId, row.id)],
    )

    const schema = adoptSchema(tenancy, {
      records: {
        table: records,
        logicalPrimaryKey: 'id',
        identity: 'global-primary-compatibility',
      },
    })

    expect(getTableCapabilities(schema.records).tenancy?.property).toBe('workspaceId')
  })

  test('requires tenant-qualified uniqueness during global-key compatibility', () => {
    const records = pgTable('unsafe_compatible_records', {
      workspaceId: pgText('workspace_id').notNull(),
      id: pgText('id').primaryKey(),
    })

    expect(() =>
      adoptSchema(tenancy, {
        records: {
          table: records,
          logicalPrimaryKey: 'id',
          identity: 'global-primary-compatibility',
        },
      }),
    ).toThrow('requires global primary key "id" and unique (workspace_id, id)')
  })

  test('rejects a foreign key that can cross the adopted tenant boundary', () => {
    const parents = tenantTable('adopted_parents')
    const children = pgTable(
      'adopted_children',
      {
        workspaceId: pgText('workspace_id').notNull(),
        id: pgText('id').notNull(),
        parentId: pgText('parent_id').notNull(),
      },
      (row) => [
        primaryKey({ columns: [row.workspaceId, row.id] }),
        foreignKey({ columns: [row.parentId], foreignColumns: [parents.id] }),
      ],
    )

    adoptSchema(tenancy, {
      parents: { table: parents, logicalPrimaryKey: 'id' },
    })

    expect(() =>
      adoptSchema(tenancy, {
        children: { table: children, logicalPrimaryKey: 'id' },
      }),
    ).toThrow('must include tenant column "workspace_id"')
  })

  test('rejects implicit cascading writes into a draftable table', () => {
    const parents = tenantTable('draftable_parents')
    const children = pgTable(
      'draftable_children',
      {
        workspaceId: pgText('workspace_id').notNull(),
        id: pgText('id').notNull(),
        parentId: pgText('parent_id').notNull(),
      },
      (row) => [
        primaryKey({ columns: [row.workspaceId, row.id] }),
        foreignKey({
          columns: [row.workspaceId, row.parentId],
          foreignColumns: [parents.workspaceId, parents.id],
        }).onDelete('cascade'),
      ],
    )

    expect(() =>
      adoptSchema(tenancy, {
        parents: { table: parents, logicalPrimaryKey: 'id', draftable: true },
        children: { table: children, logicalPrimaryKey: 'id' },
      }),
    ).toThrow('cannot use ON DELETE CASCADE because "draftable_parents" is draftable')
  })
})
