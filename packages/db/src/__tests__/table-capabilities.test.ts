import { describe, expect, test } from 'bun:test'
import { getTableColumns, getTableName } from 'drizzle-orm'
import {
  defineSchema,
  getGeneratedTables,
  getTableCapabilities,
  ColumnDef,
  int,
  jsonb,
  multiTenant,
  table,
  TableDefinition,
  text,
  timestamp,
  uuid,
} from '../index'
import { getTableConfig } from 'drizzle-orm/pg-core'

describe('composable table capabilities', () => {
  describe('table declarations', () => {
    /**
     * Only definitions minted by the public table factories may reach schema
     * compilation; prototype and registry tampering must not forge authority.
     */
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

      expect(forged instanceof TableDefinition).toBe(false)
      expect(() => forged.draftable()).toThrow('require a factory-created definition')
      expect(() => forged.revision('id')).toThrow('require a factory-created definition')
      expect(() => forged.softDelete('id')).toThrow('require a factory-created definition')
      expect(() => defineSchema({ forged })).toThrow('table(...)')
    })

    /** Custom ColumnDef subclasses are rejected before their extra behavior can be silently lost. */
    test('table declarations reject ColumnDef subclasses instead of losing their state', () => {
      class CustomColumnDef extends ColumnDef<string> {}

      expect(() => table({ custom: new CustomColumnDef({ ...text.opts }) })).toThrow(
        'plain ColumnDef instances; subclasses are unsupported',
      )
    })

    /** A table declaration is a plain enumerable column map, so hidden or augmented state fails closed. */
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

    /** Mutating caller-owned default objects after declaration cannot change the compiled schema. */
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

    /** Defaults that cannot be copied deterministically are rejected instead of retained by reference. */
    test('table declarations reject defaults that cannot be snapshotted safely', () => {
      expect(() => table({ settings: jsonb.default(new Map([['enabled', true]])) })).toThrow(
        'Column defaults must be primitives, Date values, arrays, or plain objects',
      )
    })

    /** The `wystack_` prefix belongs to framework storage, while names containing it remain legal. */
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

    /** Bare column maps cannot bypass the capability-bearing table declaration API. */
    test('schema entries must declare table capabilities explicitly', () => {
      expect(() =>
        defineSchema({
          // @ts-expect-error — bare column maps are no longer table definitions
          legacy: { id: uuid.primaryKey() },
        }),
      ).toThrow('table(...)')
    })
  })

  describe('tenant descriptors', () => {
    /** One schema can mix global, draftable, tenant, and tenant-draftable tables without losing scope metadata. */
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

    /** The tenancy descriptor owns its injected property; a domain column cannot impersonate it. */
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

    /** A descriptor snapshots its key once so later caller mutation cannot redirect tenant scope. */
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

    /** The tenant column uses the validated type snapshot even if the original ColumnDef later changes. */
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

    /** Compiled capability metadata is immutable so application code cannot disable tenant isolation. */
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

    /** The default descriptor injects a required UUID `tenantId` stored in `tenant_id`. */
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

    /** Trusted tenant inputs use database-equivalent integer, text, and UUID identities. */
    test('tenant descriptors canonicalize trusted identities with database semantics', () => {
      const intTenancy = multiTenant({
        key: { property: 'tenantId', column: 'tenant_id', type: int },
      })
      const textTenancy = multiTenant({
        key: { property: 'tenantId', column: 'tenant_id', type: text },
      })
      const uuidTenancy = multiTenant()

      expect(intTenancy.canonicalize('  +01 ')).toBe(1)
      expect(textTenancy.canonicalize('01')).toBe('01')
      expect(uuidTenancy.canonicalize('{A0B1C2D3-E4F5-6789-ABCD-EF0123456789}')).toBe(
        'a0b1c2d3-e4f5-6789-abcd-ef0123456789',
      )
      expect(() => textTenancy.canonicalize(null)).toThrow('Invalid text identity')
      expect(() => uuidTenancy.canonicalize(undefined)).toThrow('Invalid uuid identity')
    })

    /** A domain property cannot reuse the SQL column reserved for the injected tenant key. */
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
  })

  describe('revision state', () => {
    /** Draft and revision capabilities compose in either declaration order and retain both contracts. */
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

    /** A revision property is dedicated framework state, not identity, uniqueness, or a relationship. */
    test('revision columns cannot collide with identity, tenancy, uniqueness, or references', () => {
      const intTenancy = multiTenant({
        key: { property: 'tenantId', column: 'tenant_id', type: int },
      })
      expect(() =>
        intTenancy.table({ id: int.primaryKey(), name: text }).revision('tenantId'),
      ).toThrow('cannot be the tenant key')
      expect(() => table({ id: int.primaryKey() }).revision('id')).toThrow(
        'cannot be a primary key',
      )
      expect(() =>
        table({ id: uuid.primaryKey(), revision: int.unique() }).revision('revision'),
      ).toThrow('cannot be unique')
      expect(() =>
        table({ id: uuid.primaryKey(), revision: int.references('parents') }).revision('revision'),
      ).toThrow('cannot be a foreign key')
    })

    /** A table has one revision source of truth and cannot replace it later in the declaration chain. */
    test('a table cannot replace an already configured revision property', () => {
      const revisioned = table({ id: uuid.primaryKey(), revision: int, version: int }).revision(
        'revision',
      )
      expect(() =>
        // @ts-expect-error — one table has exactly one framework-managed revision property
        revisioned.revision('version'),
      ).toThrow('already configured')
    })

    /** Revision state compiles as a required integer initialized to the first incarnation token. */
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

    /** Mutating the caller's revision ColumnDef cannot alter the validated compiled revision column. */
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
  })

  describe('soft-delete state', () => {
    test('soft deletion composes with tenancy, drafts, and revisions', () => {
      const tenancy = multiTenant({
        key: { property: 'workspaceId', column: 'workspace_id', type: uuid },
      })
      const schema = defineSchema({
        records: tenancy
          .table({
            id: uuid.primaryKey(),
            name: text,
            deletedAt: timestamp.nullable(),
            revision: int,
          })
          .draftable()
          .softDelete('deletedAt')
          .revision('revision'),
      })

      expect(getTableCapabilities(schema.records)).toMatchObject({
        draftable: true,
        revisionProperty: 'revision',
        softDeleteProperty: 'deletedAt',
        tenancy: { property: 'workspaceId' },
      })
    })

    test('soft-delete properties must be dedicated nullable timestamps without defaults', () => {
      expect(() => table({ id: uuid.primaryKey() }).softDelete('id')).toThrow('nullable timestamp')
      expect(() =>
        table({ id: uuid.primaryKey(), deletedAt: timestamp }).softDelete('deletedAt'),
      ).toThrow('nullable timestamp')
      expect(() =>
        table({ id: uuid.primaryKey(), deletedAt: timestamp.nullable().defaultNow() }).softDelete(
          'deletedAt',
        ),
      ).toThrow('must not have a default')
      expect(() =>
        table({ id: uuid.primaryKey(), deletedAt: timestamp.nullable().unique() }).softDelete(
          'deletedAt',
        ),
      ).toThrow('cannot be an identity, unique, or foreign-key column')
    })
  })

  describe('compiled schema ownership', () => {
    /** Nested reference metadata is snapshotted, so later mutation cannot retarget a foreign key. */
    test('table definitions snapshot nested reference metadata', () => {
      const accountReference = uuid.references('accounts')
      const posts = table({ id: uuid.primaryKey(), accountId: accountReference })

      expect(Reflect.set(accountReference.opts.ref!, 'table', 'mutated_accounts')).toBe(true)
      expect(Reflect.set(accountReference.opts.ref!, 'column', 'mutated_id')).toBe(true)

      const schema = defineSchema({
        accounts: table({ id: uuid.primaryKey() }),
        posts,
      })
      const reference = getTableConfig(schema.posts).foreignKeys[0].reference()
      expect({
        localColumns: reference.columns.map((column) => column.name),
        targetTable: getTableName(reference.foreignTable),
        targetColumns: reference.foreignColumns.map((column) => column.name),
      }).toEqual({
        localColumns: ['accountId'],
        targetTable: 'accounts',
        targetColumns: ['id'],
      })
    })

    /** Chained references resolve to the table objects returned by defineSchema, even when both targets are rebuilt. */
    test('chained references retain the compiled target objects', () => {
      const schema = defineSchema({
        entries: table({ id: uuid.primaryKey(), folderId: uuid.references('folders') }),
        folders: table({ id: uuid.primaryKey(), accountId: uuid.references('accounts') }),
        accounts: table({ id: uuid.primaryKey() }),
      })

      const entryReference = getTableConfig(schema.entries).foreignKeys[0].reference()
      const folderReference = getTableConfig(schema.folders).foreignKeys[0].reference()

      expect(entryReference.foreignTable).toBe(schema.folders)
      expect(folderReference.foreignTable).toBe(schema.accounts)
    })

    /** A misspelled bare target fails instead of silently compiling without its foreign key. */
    test('bare references to unknown tables fail during schema definition', () => {
      expect(() =>
        defineSchema({
          posts: table({ id: uuid.primaryKey(), authorId: uuid.references('autors') }),
        }),
      ).toThrow('Reference "posts.authorId" targets unknown table "autors"')
    })

    /** All tenant tables in one schema share one descriptor and therefore one tenant dimension. */
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

    /** Tenant identities are required scalar values that PostgreSQL can compare and index consistently. */
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

    /** Any number of draftable tables share one generated row-change relation with one stable identity key. */
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
        insights: tenancy
          .table({ id: uuid.primaryKey(), description: text.nullable() })
          .draftable(),
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

    /** Draft overlays reject structured primary keys because their row identity must be scalar and stable. */
    test('draftable tables reject non-scalar stable identities', () => {
      expect(() =>
        defineSchema({ invalid: table({ id: jsonb.primaryKey(), name: text }).draftable() }),
      ).toThrow('scalar int, text, or uuid')
    })
  })

  describe('draft delete safety', () => {
    test('rejects delete actions that would mutate unreviewed dependent rows', () => {
      expect(() =>
        defineSchema({
          parents: table({ id: uuid.primaryKey() }).draftable(),
          children: table({
            id: uuid.primaryKey(),
            parentId: uuid.references('parents', 'id', 'cascade'),
          }),
        }),
      ).toThrow('cannot review or anchor untouched dependent rows')

      expect(() =>
        defineSchema({
          parents: table({ id: uuid.primaryKey() }).draftable(),
          children: table({
            id: uuid.primaryKey(),
            parentId: uuid.nullable().references('parents', 'id', 'set null'),
          }),
        }),
      ).toThrow('cannot review or anchor untouched dependent rows')

      expect(() =>
        defineSchema({
          parents: table({ id: uuid.primaryKey() }).draftable(),
          children: table({
            id: uuid.primaryKey(),
            parentId: uuid.references('parents', 'id', 'no action'),
          }),
        }),
      ).not.toThrow()
    })
  })

  describe('tenant-local constraints', () => {
    /** Physical row identity includes tenant scope while preserving the declared key as a logical column. */
    test('tenant tables compile tenant scope and logical identity as one primary key', () => {
      const tenancy = multiTenant({
        key: {
          property: 'workspaceId',
          column: 'workspace_id',
          type: uuid,
        },
      })
      const schema = defineSchema({
        accounts: tenancy.table({ id: uuid.primaryKey(), slug: text }),
      })

      const config = getTableConfig(schema.accounts)
      expect(config.primaryKeys).toHaveLength(1)
      expect(config.primaryKeys[0].columns.map((column) => column.name)).toEqual([
        'workspace_id',
        'id',
      ])
      expect(config.columns.find((column) => column.name === 'id')?.primary).toBe(false)
    })

    /** Tenant-local uniqueness and references include tenant identity in their compiled constraints. */
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

      const accountConstraints = getTableConfig(schema.accounts).uniqueConstraints.map(
        (constraint) => constraint.columns.map((column) => column.name),
      )
      const postReference = getTableConfig(schema.posts).foreignKeys[0].reference()

      expect(accountConstraints).toContainEqual(['workspace_id', 'slug'])
      expect({
        localColumns: postReference.columns.map((column) => column.name),
        targetTable: getTableName(postReference.foreignTable),
        targetColumns: postReference.foreignColumns.map((column) => column.name),
      }).toEqual({
        localColumns: ['workspace_id', 'accountId'],
        targetTable: 'accounts',
        targetColumns: ['workspace_id', 'id'],
      })
    })

    /** Tenant-local constraints on a global table fail instead of compiling without tenant scope. */
    test('tenant-local constraints fail on plain tables', () => {
      expect(() =>
        defineSchema({
          invalid: table({ id: uuid.primaryKey(), slug: text.uniqueWithinTenant() }),
        }),
      ).toThrow('tenant-isolated')
    })

    /** A misspelled tenant-local target fails at defineSchema rather than omitting isolation. */
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

    /** Two-pass compilation resolves a tenant-local target declared later without losing table capabilities. */
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
      expect(getTableCapabilities(schema.tasks).tenancy).toMatchObject({
        property: 'workspaceId',
        column: 'workspace_id',
      })
    })

    /** Tenant-local references cannot point at global rows because the target has no matching tenant key. */
    test('a tenant-local reference rejects a non-tenant target during schema definition', () => {
      const tenancy = multiTenant({
        key: { property: 'workspaceId', column: 'workspace_id', type: uuid },
      })

      expect(() =>
        defineSchema({
          projects: table({ id: uuid.primaryKey() }),
          tasks: tenancy.table({
            id: uuid.primaryKey(),
            projectId: uuid.referencesWithinTenant('projects'),
          }),
        }),
      ).toThrow('targets non-tenant table "projects"')
    })

    /** SET NULL is rejected because PostgreSQL would also clear the required tenant half of the composite key. */
    test('tenant-local references reject ON DELETE SET NULL before emitting an invalid composite FK', () => {
      const tenancy = multiTenant({
        key: { property: 'workspaceId', column: 'workspace_id', type: uuid },
      })

      expect(() =>
        defineSchema({
          projects: tenancy.table({ id: uuid.primaryKey() }),
          tasks: tenancy.table({
            id: uuid.primaryKey(),
            projectId: uuid.nullable().referencesWithinTenant('projects', 'id', 'set null'),
          }),
        }),
      ).toThrow('cannot use ON DELETE SET NULL')
    })

    /** Every reference to a tenant table needs a tenant key; global lookup targets remain legal. */
    test('a bare reference to a tenant-isolated table must be tenant-qualified', () => {
      const tenancy = multiTenant({
        key: { property: 'workspaceId', column: 'workspace_id', type: uuid },
      })
      expect(() =>
        defineSchema({
          projects: tenancy.table({ id: uuid.primaryKey() }),
          tasks: tenancy.table({ id: uuid.primaryKey(), projectId: uuid.references('projects') }),
        }),
      ).toThrow('use referencesWithinTenant()')

      expect(() =>
        defineSchema({
          projects: tenancy.table({ id: uuid.primaryKey() }),
          auditEvents: table({ id: uuid.primaryKey(), projectId: uuid.references('projects') }),
        }),
      ).toThrow('make the source table tenant-isolated and use referencesWithinTenant()')

      // A plain lookup table has no tenant to cross, so a bare reference to it stays legal.
      const schema = defineSchema({
        statuses: table({ id: uuid.primaryKey(), label: text }),
        tasks: tenancy.table({ id: uuid.primaryKey(), statusId: uuid.references('statuses') }),
      })
      expect(getTableConfig(schema.tasks).foreignKeys).toHaveLength(1)
    })
  })
})
