/**
 * Compile-time regression for framework-managed mutation fields.
 *
 * Tenant and revision properties remain readable on returned rows, but callers
 * cannot supply them to tracked canonical or draft inserts/updates. This file
 * deliberately is not a runtime test: `tsc --noEmit` is the proof surface.
 */
import { defineSchema, int, multiTenant, table, text, uuid } from './index'
import type { DrizzleTracker } from './tracker-core'

type Expect<T extends true> = T

const tenancy = multiTenant({
  key: {
    property: 'workspaceId',
    column: 'workspace_id',
    type: text,
  },
})

const schema = defineSchema({
  global: table({ id: uuid.primaryKey(), name: text }),
  globalVersioned: table({ id: uuid.primaryKey(), name: text, revision: int }).revision('revision'),
  tenant: tenancy.table({ id: uuid.primaryKey(), name: text }),
  tenantVersioned: tenancy
    .table({ id: uuid.primaryKey(), name: text, revision: int })
    .draftable()
    .revision('revision'),
})

declare const tracked: DrizzleTracker

// Keep the end-to-end builder calls unreachable at runtime while asking the
// compiler to validate the exact public signatures.
// oxlint-disable-next-line eslint/no-constant-condition -- compile-time-only contract block
if (false) {
  const scoped = tracked.withTenant('alpha')
  const draft = scoped.withDraft('draft-1')

  void tracked.into(schema.global).insert({ id: 'global-1', name: 'global' })
  void tracked.from(schema.global).update({ name: 'renamed' })
  void scoped.into(schema.tenant).insert({ id: 'tenant-1', name: 'tenant' })
  void scoped.from(schema.tenant).update({ name: 'renamed' })
  void tracked.into(schema.globalVersioned).insert({ id: 'global-versioned-1', name: 'versioned' })
  void draft.into(schema.tenantVersioned).insert({ id: 'tenant-versioned-1', name: 'drafted' })
  void draft.from(schema.tenantVersioned).update({ name: 'renamed' })

  // @ts-expect-error — tenant identity comes only from the trusted scoped handle
  void scoped.into(schema.tenant).insert({ id: 'forged', name: 'tenant', workspaceId: 'beta' })
  // @ts-expect-error — tenant identity is immutable through tracked updates
  void scoped.from(schema.tenant).update({ workspaceId: 'beta' })
  void tracked.into(schema.globalVersioned).insert({
    id: 'forged',
    name: 'versioned',
    // @ts-expect-error — revision tokens are allocated by the framework
    revision: 99,
  })
  // @ts-expect-error — revision tokens are advanced by the framework
  void tracked.from(schema.globalVersioned).update({ revision: 99 })
  void draft.into(schema.tenantVersioned).insert({
    id: 'forged',
    name: 'drafted',
    // @ts-expect-error — draft inserts cannot provide tenant identity
    workspaceId: 'beta',
    // @ts-expect-error — draft inserts cannot provide revision tokens
    revision: 99,
  })
  // @ts-expect-error — draft updates cannot provide tenant identity
  void draft.from(schema.tenantVersioned).update({ workspaceId: 'beta' })
  // @ts-expect-error — draft updates cannot provide revision tokens
  void draft.from(schema.tenantVersioned).update({ revision: 99 })
}

type TenantVersionedRow = typeof schema.tenantVersioned.$inferSelect
type _ManagedPropertiesRemainReadable = Expect<
  'workspaceId' | 'revision' extends keyof TenantVersionedRow ? true : false
>

export type __SystemManagedInputContract = [_ManagedPropertiesRemainReadable]
