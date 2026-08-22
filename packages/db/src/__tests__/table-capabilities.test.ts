import { describe, expect, test } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'
import {
  defineSchema,
  getGeneratedTables,
  getTableCapabilities,
  int,
  multiTenant,
  renderCreateTableIfNotExists,
  table,
  text,
  uuid,
} from '../index'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('composable table capabilities', () => {
  test('plain, draftable, tenant, and tenant-draftable tables compile from one model', () => {
    const tenancy = multiTenant({
      key: {
        property: 'workspaceId',
        column: 'workspace_id',
        type: uuid,
      },
    })

    const schema = defineSchema({
      catalog: table({ id: int.primaryKey(), name: text }),
      templates: table({ id: uuid.primaryKey(), name: text }).draftable(),
      connections: tenancy.table({ id: uuid.primaryKey(), name: text }),
      insights: tenancy.table({ id: uuid.primaryKey(), name: text }).draftable(),
    })

    expect(getTableCapabilities(schema.catalog)).toEqual({ draftable: false })
    expect(getTableCapabilities(schema.templates)).toEqual({ draftable: true })
    expect(getTableCapabilities(schema.connections)).toMatchObject({
      draftable: false,
      tenancy: { property: 'workspaceId', column: 'workspace_id' },
    })
    expect(getTableCapabilities(schema.insights)).toMatchObject({
      draftable: true,
      tenancy: { property: 'workspaceId', column: 'workspace_id' },
    })

    expect(Object.keys(getTableColumns(schema.catalog))).toEqual(['id', 'name'])
    expect(getTableColumns(schema.connections).workspaceId.name).toBe('workspace_id')
    expect(getTableColumns(schema.connections).workspaceId.notNull).toBe(true)
  })

  test('tenant key configuration is declared once and cannot collide with a domain column', () => {
    const tenancy = multiTenant({
      key: {
        property: 'workspaceId',
        column: 'workspace_id',
        type: uuid,
      },
    })

    expect(() =>
      // @ts-expect-error — the typed boundary rejects this; exercise the runtime guard too
      tenancy.table({
        id: uuid.primaryKey(),
        workspaceId: uuid,
      }),
    ).toThrow('workspaceId')
  })

  test('draftable tables generate presence-aware shadow schemas', () => {
    const tenancy = multiTenant({
      key: {
        property: 'workspaceId',
        column: 'workspace_id',
        type: uuid,
      },
    })
    const schema = defineSchema({
      templates: table({ id: uuid.primaryKey(), description: text.nullable() }).draftable(),
      insights: tenancy
        .table({ id: uuid.primaryKey(), description: text.nullable() })
        .draftable(),
    })

    const generated = getGeneratedTables(schema)
    expect(generated.map((generatedTable) => getTableConfig(generatedTable).name)).toEqual([
      'templates__draft',
      'insights__draft',
    ])

    const tenantShadow = getTableConfig(generated[1])
    expect(tenantShadow.columns.map((column) => column.name)).toEqual([
      'draft_id',
      'workspace_id',
      'id',
      'description',
      '__overrides',
      '__tombstone',
    ])
    expect(tenantShadow.primaryKeys[0].columns.map((column) => column.name)).toEqual([
      'draft_id',
      'workspace_id',
      'id',
    ])
    expect(tenantShadow.columns.find((column) => column.name === 'description')?.notNull).toBe(
      false,
    )
  })

  test('tenant-local uniqueness and references include the tenant key', () => {
    const tenancy = multiTenant({
      key: {
        property: 'workspaceId',
        column: 'workspace_id',
        type: uuid,
      },
    })
    const schema = defineSchema({
      accounts: tenancy.table({
        id: uuid.primaryKey(),
        slug: text.uniqueWithinTenant(),
      }),
      posts: tenancy.table({
        id: uuid.primaryKey(),
        accountId: uuid.referencesWithinTenant('accounts'),
      }),
    })

    const accountsDdl = renderCreateTableIfNotExists(schema.accounts)
    const postsDdl = renderCreateTableIfNotExists(schema.posts)
    expect(accountsDdl).toContain('UNIQUE ("workspace_id", "id")')
    expect(accountsDdl).toContain('UNIQUE ("workspace_id", "slug")')
    expect(postsDdl).toContain(
      'FOREIGN KEY ("workspace_id", "accountId") REFERENCES "accounts" ("workspace_id", "id")',
    )
  })

  test('tenant-local constraints fail on plain tables', () => {
    expect(() =>
      defineSchema({
        invalid: table({ id: uuid.primaryKey(), slug: text.uniqueWithinTenant() }),
      }),
    ).toThrow('tenant-isolated')
  })
})
