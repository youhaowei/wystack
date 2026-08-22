import { describe, expect, test } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'
import {
  defineSchema,
  getTableCapabilities,
  int,
  multiTenant,
  table,
  text,
  uuid,
} from '../index'

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
})
