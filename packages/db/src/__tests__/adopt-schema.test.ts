import { afterEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import {
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text as pgText,
  timestamp as pgTimestamp,
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

function softDeleteTenantTable(name: string) {
  return pgTable(
    name,
    {
      workspaceId: pgText('workspace_id').notNull(),
      id: pgText('id').notNull(),
      value: pgText('value').notNull(),
      deletedAt: pgTimestamp('deleted_at'),
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
  test('rejects a reserved physical table name before registration', () => {
    const records = tenantTable('wystack_draft_row_changes')

    expect(() =>
      adoptSchema(tenancy, {
        recordsAlias: { table: records, logicalPrimaryKey: 'id', draftable: true },
      }),
    ).toThrow(
      'Table name "wystack_draft_row_changes" uses the reserved "wystack_" framework namespace',
    )
    expect(() => getTableCapabilities(records)).toThrow('Table was not compiled by defineSchema')
  })

  test('adds native tenant and draft custody to the authoritative Drizzle table', async () => {
    const records = softDeleteTenantTable('adopted_records')
    const schema = adoptSchema(tenancy, {
      records: {
        table: records,
        logicalPrimaryKey: 'id',
        draftable: true,
        revisionProperty: 'rowRevision',
        softDeleteProperty: 'deletedAt',
      },
    })

    expect(schema.records as unknown).toBe(records as unknown)
    expect(getTableCapabilities(records)).toMatchObject({
      draftable: true,
      revisionProperty: 'rowRevision',
      softDeleteProperty: 'deletedAt',
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

  test('allows identical aliases for one authoritative table', () => {
    const records = softDeleteTenantTable('identically_aliased_records')
    const config = {
      table: records,
      logicalPrimaryKey: 'id' as const,
      draftable: true,
      revisionProperty: 'rowRevision' as const,
      softDeleteProperty: 'deletedAt' as const,
    }

    const schema = adoptSchema(tenancy, {
      records: config,
      recordsAlias: { ...config },
    })

    expect(schema.records as unknown).toBe(records as unknown)
    expect(schema.recordsAlias as unknown).toBe(records as unknown)
    expect(getTableCapabilities(records)).toMatchObject({
      draftable: true,
      revisionProperty: 'rowRevision',
      softDeleteProperty: 'deletedAt',
    })
  })

  const duplicateConfigurationCases = [
    {
      contract: 'logical primary key',
      first: { logicalPrimaryKey: 'id' as const },
      second: { logicalPrimaryKey: 'value' as const },
    },
    {
      contract: 'draft custody',
      first: { logicalPrimaryKey: 'id' as const, draftable: true },
      second: { logicalPrimaryKey: 'id' as const, draftable: false },
    },
    {
      contract: 'revision custody',
      first: { logicalPrimaryKey: 'id' as const, revisionProperty: 'rowRevision' as const },
      second: { logicalPrimaryKey: 'id' as const },
    },
    {
      contract: 'soft-delete custody',
      first: { logicalPrimaryKey: 'id' as const, softDeleteProperty: 'deletedAt' as const },
      second: { logicalPrimaryKey: 'id' as const },
    },
    {
      contract: 'identity mode',
      first: { logicalPrimaryKey: 'id' as const, identity: 'tenant-primary' as const },
      second: {
        logicalPrimaryKey: 'id' as const,
        identity: 'global-primary-compatibility' as const,
      },
    },
  ]

  for (const [index, example] of duplicateConfigurationCases.entries()) {
    test(`rejects duplicate aliases with conflicting ${example.contract}`, () => {
      const records = softDeleteTenantTable(`conflicting_alias_records_${index}`)

      expect(() =>
        adoptSchema(tenancy, {
          first: { table: records, ...example.first },
          second: { table: records, ...example.second },
        }),
      ).toThrow('configured more than once with a different adoption contract')

      // Conflict detection happens before registration, so a corrected retry
      // can adopt the table without inheriting the rejected alias metadata.
      expect(
        adoptSchema(tenancy, {
          records: { table: records, logicalPrimaryKey: 'id' },
        }).records as unknown,
      ).toBe(records as unknown)
    })
  }

  test('rejects re-adoption under a different tenancy descriptor', () => {
    const records = tenantTable('descriptor_conflict_records')
    adoptSchema(tenancy, {
      records: { table: records, logicalPrimaryKey: 'id' },
    })
    const otherTenancy = multiTenant({
      key: { property: 'workspaceId', column: 'workspace_id', type: text },
    })

    expect(() =>
      adoptSchema(otherTenancy, {
        recordsAlias: { table: records, logicalPrimaryKey: 'id' },
      }),
    ).toThrow('already registered with different capabilities')
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

  test('validates the adopted tombstone against the physical Drizzle column', () => {
    const required = pgTable(
      'required_deleted_at_records',
      {
        workspaceId: pgText('workspace_id').notNull(),
        id: pgText('id').notNull(),
        deletedAt: pgTimestamp('deleted_at').notNull(),
      },
      (row) => [primaryKey({ columns: [row.workspaceId, row.id] })],
    )
    const defaulted = pgTable(
      'defaulted_deleted_at_records',
      {
        workspaceId: pgText('workspace_id').notNull(),
        id: pgText('id').notNull(),
        deletedAt: pgTimestamp('deleted_at').defaultNow(),
      },
      (row) => [primaryKey({ columns: [row.workspaceId, row.id] })],
    )

    expect(() =>
      adoptSchema(tenancy, {
        records: {
          table: required,
          logicalPrimaryKey: 'id',
          softDeleteProperty: 'deletedAt',
        },
      }),
    ).toThrow('must be a nullable timestamp without a default')
    expect(() =>
      adoptSchema(tenancy, {
        records: {
          table: defaulted,
          logicalPrimaryKey: 'id',
          softDeleteProperty: 'deletedAt',
        },
      }),
    ).toThrow('must be a nullable timestamp without a default')
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
