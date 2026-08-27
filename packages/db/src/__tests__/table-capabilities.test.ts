import { describe, expect, test } from 'bun:test'
import { getTableColumns } from 'drizzle-orm'
import {
  defineSchema,
  getGeneratedTables,
  getTableCapabilities,
  ColumnDef,
  int,
  jsonb,
  multiTenant,
  renderCreateTableIfNotExists,
  table,
  TableDefinition,
  text,
  timestamp,
  uuid,
} from '../index'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('composable table capabilities', () => {
  test('only table factories can construct authentic table definitions', () => {
    const authentic = table({ id: uuid.primaryKey() })
    expect(authentic).toBeInstanceOf(TableDefinition)

    expect(
      () =>
        // @ts-expect-error — application code cannot construct table definitions directly
        new TableDefinition(Symbol('forged'), { id: uuid.primaryKey() }, { draftable: false }),
    ).toThrow('TableDefinition cannot be constructed directly')

    const forged = Object.assign(Object.create(TableDefinition.prototype), {
      columns: { id: uuid.primaryKey() },
      capabilities: { draftable: false },
    }) as typeof authentic
    expect(Reflect.set(TableDefinition, Symbol.hasInstance, () => true)).toBe(false)

    const originalWeakSetHas = WeakSet.prototype.has
    let forgedInstanceof = true
    let mintError: unknown
    const weakSetHasPatched = Reflect.set(WeakSet.prototype, 'has', () => true)
    let weakSetHasRestored = false
    try {
      forgedInstanceof = forged instanceof TableDefinition
      try {
        forged.draftable()
      } catch (error) {
        mintError = error
      }
    } finally {
      weakSetHasRestored = Reflect.set(WeakSet.prototype, 'has', originalWeakSetHas)
    }

    expect(weakSetHasPatched).toBe(true)
    expect(weakSetHasRestored).toBe(true)
    expect(forgedInstanceof).toBe(false)
    expect(mintError).toBeInstanceOf(Error)
    expect((mintError as Error).message).toContain('require a factory-created definition')
    expect(() => forged.revision('id')).toThrow('require a factory-created definition')
    expect(() => defineSchema({ forged })).toThrow('table(...)')
  })

  test('table declarations reject ColumnDef subclasses instead of losing their state', () => {
    class CustomColumnDef extends ColumnDef<string> {}

    expect(() => table({ custom: new CustomColumnDef({ ...text.opts }) })).toThrow(
      'plain ColumnDef instances; subclasses are unsupported',
    )
  })

  test('table declarations reject augmented columns and hidden map state', () => {
    const extended = Object.assign(new ColumnDef<string>({ ...text.opts }), {
      marker: 'kept',
      read() {
        return this.marker
      },
    })
    expect(() => table({ extended })).toThrow('cannot carry custom own state')

    const columns = { id: uuid.primaryKey() }
    Object.defineProperty(columns, 'hidden', {
      value: text,
      enumerable: false,
    })
    expect(() => table(columns)).toThrow('plain map of enumerable string properties')
  })

  test('date and structured defaults remain stable after table declaration', () => {
    const originalDate = new Date('2025-01-02T03:04:05.000Z')
    const structuredDefault = {
      enabled: true,
      filters: { status: 'open' },
      labels: ['first'],
    }
    const records = table({
      id: uuid.primaryKey(),
      createdAt: timestamp.default(originalDate),
      settings: jsonb.default(structuredDefault),
    })

    originalDate.setUTCFullYear(2030)
    structuredDefault.filters.status = 'closed'
    structuredDefault.labels.push('mutated')

    const exposedDate = records.columns.createdAt.opts.defaultValue as Date
    exposedDate.setUTCFullYear(2040)
    const exposedSettings = records.columns.settings.opts.defaultValue as typeof structuredDefault
    expect(Reflect.set(exposedSettings.filters, 'status', 'mutated_again')).toBe(false)
    expect(Reflect.set(exposedSettings.labels, '0', 'mutated_again')).toBe(false)

    const schema = defineSchema({ records })
    expect(getTableColumns(schema.records).createdAt.default).toEqual(
      new Date('2025-01-02T03:04:05.000Z'),
    )
    expect(getTableColumns(schema.records).settings.default).toEqual({
      enabled: true,
      filters: { status: 'open' },
      labels: ['first'],
    })
  })

  test('table declarations reject defaults that cannot be snapshotted safely', () => {
    expect(() => table({ settings: jsonb.default(new Map([['enabled', true]])) })).toThrow(
      'Column defaults must be primitives, Date values, arrays, or plain objects',
    )
  })

  test('application tables cannot use the reserved wystack_ namespace', () => {
    const reservedNames = [
      'wystack_framework_migrations',
      'wystack_drafts',
      'wystack_draft_commands',
      'wystack_draft_tables',
      'wystack_draft_row_changes',
      'wystack_row_revisions',
      'wystack_future_internal',
    ]

    for (const tableName of reservedNames) {
      expect(() =>
        defineSchema({
          [tableName]: table({ id: uuid.primaryKey() }),
        }),
      ).toThrow(`Table name "${tableName}" uses the reserved "wystack_" framework namespace`)
    }

    expect(() =>
      defineSchema({
        application_wystack_jobs: table({ id: uuid.primaryKey() }),
      }),
    ).not.toThrow()
  })

  test('schema entries must declare table capabilities explicitly', () => {
    expect(() =>
      defineSchema({
        // @ts-expect-error — bare column maps are no longer table definitions
        legacy: { id: uuid.primaryKey() },
      }),
    ).toThrow('table(...)')
  })

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

  test('tenant descriptors snapshot and freeze their configured key', () => {
    const configuredKey = {
      property: 'workspaceId',
      column: 'workspace_id',
      type: uuid,
    } as const
    const tenancy = multiTenant({ key: configuredKey })
    const first = tenancy.table({ id: uuid.primaryKey() })

    expect(Reflect.set(configuredKey, 'property', 'accountId')).toBe(true)
    expect(Reflect.set(configuredKey, 'column', 'account_id')).toBe(true)
    expect(Reflect.set(tenancy.key, 'property', 'mutatedId')).toBe(false)

    const second = tenancy.table({ id: uuid.primaryKey() })
    const schema = defineSchema({ first, second })
    expect(Object.isFrozen(tenancy.key)).toBe(true)
    expect(Object.keys(getTableColumns(schema.first))).toContain('workspaceId')
    expect(Object.keys(getTableColumns(schema.second))).toContain('workspaceId')
    expect(getTableCapabilities(schema.second).tenancy).toMatchObject({
      property: 'workspaceId',
      column: 'workspace_id',
    })
  })

  test('tenant descriptors retain the column type that passed validation', () => {
    const tenantType = new ColumnDef<string>({ ...uuid.opts })
    const tenancy = multiTenant({
      key: {
        property: 'workspaceId',
        column: 'workspace_id',
        type: tenantType,
      },
    })

    expect(Reflect.set(tenantType.opts, 'type', 'jsonb')).toBe(true)
    expect(Reflect.set(tenantType.opts, 'isNullable', true)).toBe(true)

    const schema = defineSchema({
      records: tenancy.table({ id: uuid.primaryKey() }),
    })
    expect(tenancy.key.type.opts).toMatchObject({
      type: 'uuid',
      isNullable: false,
    })
    expect(Object.isFrozen(tenancy.key.type.opts)).toBe(true)
    expect(getTableCapabilities(schema.records).tenancy?.type.opts.type).toBe('uuid')
    expect(getTableColumns(schema.records).workspaceId).toMatchObject({
      dataType: 'string',
      notNull: true,
    })
    expect(getTableColumns(schema.records).workspaceId.getSQLType()).toBe('uuid')
  })

  test('compiled capabilities cannot be mutated to disable tenant isolation', () => {
    const tenancy = multiTenant({
      key: { property: 'workspaceId', column: 'workspace_id', type: uuid },
    })
    const definition = tenancy.table({ id: uuid.primaryKey() })
    const schema = defineSchema({ records: definition })
    const compiledCapabilities = getTableCapabilities(schema.records)

    expect(Reflect.set(definition.capabilities, 'tenancy', undefined)).toBe(false)
    expect(Reflect.set(compiledCapabilities, 'tenancy', undefined)).toBe(false)
    expect(Object.isFrozen(definition.capabilities)).toBe(true)
    expect(Object.isFrozen(compiledCapabilities.tenancy)).toBe(true)
    expect(getTableCapabilities(schema.records).tenancy).toMatchObject({
      property: 'workspaceId',
      column: 'workspace_id',
    })
  })

  test('multiTenant defaults to the conventional tenantId/tenant_id UUID key', () => {
    const schema = defineSchema({
      records: multiTenant().table({ id: uuid.primaryKey(), name: text }),
    })

    expect(getTableCapabilities(schema.records).tenancy).toMatchObject({
      property: 'tenantId',
      column: 'tenant_id',
    })
    expect(getTableColumns(schema.records).tenantId.getSQLType()).toBe('uuid')
  })

  test('multiTenant rejects a domain property that collides with the tenant SQL column', () => {
    expect(() =>
      multiTenant({
        key: { property: 'workspaceId', column: 'workspace_id', type: uuid },
      }).table({
        id: uuid.primaryKey(),
        workspace_id: text,
      }),
    ).toThrow('SQL column "workspace_id"')
  })

  test('revision and draft capabilities compose in either order', () => {
    const first = table({ id: uuid.primaryKey(), revision: int, name: text })
      .revision('revision')
      .draftable()
    const second = table({ id: uuid.primaryKey(), version: int, name: text })
      .draftable()
      .revision('version')
    const schema = defineSchema({ first, second })

    expect(getTableCapabilities(schema.first)).toMatchObject({
      draftable: true,
      revisionProperty: 'revision',
    })
    expect(getTableCapabilities(schema.second)).toMatchObject({
      draftable: true,
      revisionProperty: 'version',
    })
  })

  test('revision columns cannot collide with identity, tenancy, uniqueness, or references', () => {
    const intTenancy = multiTenant({
      key: { property: 'tenantId', column: 'tenant_id', type: int },
    })
    expect(() =>
      intTenancy.table({ id: int.primaryKey(), name: text }).revision('tenantId'),
    ).toThrow('cannot be the tenant key')
    expect(() => table({ id: int.primaryKey() }).revision('id')).toThrow('cannot be a primary key')
    expect(() =>
      table({ id: uuid.primaryKey(), revision: int.unique() }).revision('revision'),
    ).toThrow('cannot be unique')
    expect(() =>
      table({ id: uuid.primaryKey(), revision: int.references('parents') }).revision('revision'),
    ).toThrow('cannot be a foreign key')
  })

  test('a table cannot replace an already configured revision property', () => {
    const revisioned = table({ id: uuid.primaryKey(), revision: int, version: int }).revision(
      'revision',
    )
    expect(() =>
      // @ts-expect-error — one table has exactly one framework-managed revision property
      revisioned.revision('version'),
    ).toThrow('already configured')
  })

  test('revision columns are framework-managed integers', () => {
    expect(() => table({ id: uuid.primaryKey(), revision: text }).revision('revision')).toThrow(
      'must be an integer',
    )

    const schema = defineSchema({
      records: table({ id: uuid.primaryKey(), revision: int }).revision('revision'),
    })
    expect(getTableColumns(schema.records).revision).toMatchObject({
      hasDefault: true,
      notNull: true,
      default: 1,
    })
  })

  test('revision columns retain the definition that passed validation', () => {
    const revisionColumn = new ColumnDef<number>({ ...int.opts })
    const records = table({
      id: uuid.primaryKey(),
      revision: revisionColumn,
    }).revision('revision')

    expect(Reflect.set(revisionColumn.opts, 'type', 'text')).toBe(true)
    expect(Reflect.set(revisionColumn.opts, 'isOptional', true)).toBe(true)
    expect(
      Reflect.set(revisionColumn.opts, 'ref', {
        table: 'parents',
        column: 'id',
      }),
    ).toBe(true)

    const schema = defineSchema({ records })
    expect(records.columns.revision.opts).toMatchObject({
      type: 'int',
      isOptional: false,
    })
    expect(records.columns.revision.opts.ref).toBeUndefined()
    expect(Object.isFrozen(records.columns.revision.opts)).toBe(true)
    expect(getTableCapabilities(schema.records).revisionProperty).toBe('revision')
    expect(getTableColumns(schema.records).revision).toMatchObject({
      hasDefault: true,
      notNull: true,
      default: 1,
    })
    expect(getTableColumns(schema.records).revision.getSQLType()).toBe('integer')
  })

  test('table definitions snapshot nested reference metadata', () => {
    const accountReference = uuid.references('accounts')
    const posts = table({ id: uuid.primaryKey(), accountId: accountReference })

    expect(Reflect.set(accountReference.opts.ref!, 'table', 'mutated_accounts')).toBe(true)
    expect(Reflect.set(accountReference.opts.ref!, 'column', 'mutated_id')).toBe(true)

    const schema = defineSchema({
      accounts: table({ id: uuid.primaryKey() }),
      posts,
    })
    expect(renderCreateTableIfNotExists(schema.posts)).toContain('REFERENCES "accounts" ("id")')
  })

  test('one schema cannot mix tenancy descriptors', () => {
    const first = multiTenant({
      key: { property: 'tenantId', column: 'tenant_id', type: text },
    })
    const second = multiTenant({
      key: { property: 'tenantId', column: 'tenant_id', type: text },
    })

    expect(() =>
      defineSchema({
        first: first.table({ id: uuid.primaryKey() }),
        second: second.table({ id: uuid.primaryKey() }),
      }),
    ).toThrow('exactly one multiTenant descriptor')
  })

  test('tenant keys are required scalar text, uuid, or int values', () => {
    expect(() =>
      multiTenant({
        key: { property: 'tenantId', column: 'tenant_id', type: jsonb },
      }),
    ).toThrow('scalar text, uuid, or int')
    expect(() =>
      multiTenant({
        key: { property: 'tenantId', column: 'tenant_id', type: text.array() },
      }),
    ).toThrow('scalar text, uuid, or int')
  })

  test('draftable tables share one central sparse change relation', () => {
    const tenancy = multiTenant({
      key: {
        property: 'workspaceId',
        column: 'workspace_id',
        type: uuid,
      },
    })
    const schema = defineSchema({
      templates: table({ id: uuid.primaryKey(), description: text.nullable() }).draftable(),
      insights: tenancy.table({ id: uuid.primaryKey(), description: text.nullable() }).draftable(),
    })

    const generated = getGeneratedTables(schema)
    expect(generated.map((generatedTable) => getTableConfig(generatedTable).name)).toEqual([
      'wystack_draft_row_changes',
    ])

    const changes = getTableConfig(generated[0])
    expect(changes.columns.map((column) => column.name)).toEqual([
      'draft_id',
      'table_key',
      'tenant_key_text',
      'tenant_key',
      'row_key_text',
      'row_key',
      'operation',
      'base_exists',
      'base_revision',
      'fields',
    ])
    expect(changes.primaryKeys[0].columns.map((column) => column.name)).toEqual([
      'draft_id',
      'table_key',
      'tenant_key_text',
      'row_key_text',
    ])
  })

  test('draftable tables reject non-scalar stable identities', () => {
    expect(() =>
      defineSchema({ invalid: table({ id: jsonb.primaryKey(), name: text }).draftable() }),
    ).toThrow('scalar int, text, or uuid')
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

  test('a tenant-local reference to an unknown table is an error, not a missing constraint', () => {
    const tenancy = multiTenant({
      key: { property: 'workspaceId', column: 'workspace_id', type: uuid },
    })
    expect(() =>
      defineSchema({
        projects: tenancy.table({ id: uuid.primaryKey() }),
        tasks: tenancy.table({
          id: uuid.primaryKey(),
          projectId: uuid.referencesWithinTenant('projcts'),
        }),
      }),
    ).toThrow('unknown table "projcts"')
  })

  test('a tenant-local reference may name a table defined later in the schema', () => {
    const tenancy = multiTenant({
      key: { property: 'workspaceId', column: 'workspace_id', type: uuid },
    })
    const schema = defineSchema({
      tasks: tenancy.table({
        id: uuid.primaryKey(),
        projectId: uuid.referencesWithinTenant('projects'),
      }),
      projects: tenancy.table({ id: uuid.primaryKey() }),
    })
    expect(getTableConfig(schema.tasks).foreignKeys).toHaveLength(1)
  })

  test('a bare reference between tenant-isolated tables must be tenant-qualified', () => {
    const tenancy = multiTenant({
      key: { property: 'workspaceId', column: 'workspace_id', type: uuid },
    })
    expect(() =>
      defineSchema({
        projects: tenancy.table({ id: uuid.primaryKey() }),
        tasks: tenancy.table({ id: uuid.primaryKey(), projectId: uuid.references('projects') }),
      }),
    ).toThrow('use referencesWithinTenant()')

    // A plain lookup table has no tenant to cross, so a bare reference to it stays legal.
    const schema = defineSchema({
      statuses: table({ id: uuid.primaryKey(), label: text }),
      tasks: tenancy.table({ id: uuid.primaryKey(), statusId: uuid.references('statuses') }),
    })
    expect(getTableConfig(schema.tasks).foreignKeys).toHaveLength(1)
  })
})
