/**
 * Compile-time proof for fields owned by WyStack.
 *
 * Read this file as three contracts:
 * 1. Application fields remain writable through canonical, tenant, and draft handles.
 * 2. Tenant identities come only from `withTenant(...)`.
 * 3. Revision tokens come only from WyStack's revision allocator.
 *
 * A call without `@ts-expect-error` must compile. A prohibited call has an
 * adjacent `@ts-expect-error`; `tsc --noEmit` fails if that call ever becomes
 * legal. The final function separately proves that returned rows expose managed
 * fields with their domain types and reject an invented property.
 */
import { defineSchema, int, multiTenant, table, text, uuid } from './index'
import type { DrizzleTracker } from './tracker-core'

const workspaces = multiTenant({
  key: {
    property: 'workspaceId',
    column: 'workspace_id',
    type: text,
  },
})

const schema = defineSchema({
  projects: table({ id: uuid.primaryKey(), name: text }),
  versionedProjects: table({ id: uuid.primaryKey(), name: text, revision: int }).revision(
    'revision',
  ),
  workspaceProjects: workspaces.table({ id: uuid.primaryKey(), name: text }),
  draftProjects: workspaces
    .table({ id: uuid.primaryKey(), name: text, revision: int })
    .draftable()
    .revision('revision'),
})

declare const tracked: DrizzleTracker

/** Domain fields stay writable on every public mutation path. */
function applicationFieldsRemainWritable() {
  const scoped = tracked.withTenant('alpha')
  const draft = scoped.withDraft('draft-1')

  void tracked.into(schema.projects).insert({ id: 'global-1', name: 'global' })
  void tracked.from(schema.projects).update({ name: 'renamed' })
  void scoped.into(schema.workspaceProjects).insert({ id: 'tenant-1', name: 'tenant' })
  void scoped.from(schema.workspaceProjects).update({ name: 'renamed' })
  void tracked
    .into(schema.versionedProjects)
    .insert({ id: 'global-versioned-1', name: 'versioned' })
  void draft.into(schema.draftProjects).insert({ id: 'tenant-versioned-1', name: 'drafted' })
  void draft.from(schema.draftProjects).update({ name: 'renamed' })
}

/** Tenant identity is selected by the trusted handle, never by mutation input. */
function tenantIdentityCannotBeWritten() {
  const scoped = tracked.withTenant('alpha')
  const draft = scoped.withDraft('draft-1')

  void scoped.into(schema.workspaceProjects).insert({
    id: 'forged',
    name: 'tenant',
    // @ts-expect-error — tenant identity comes only from the trusted scoped handle
    workspaceId: 'beta',
  })
  // @ts-expect-error — tenant identity is immutable through tracked updates
  void scoped.from(schema.workspaceProjects).update({ workspaceId: 'beta' })
  void draft.into(schema.draftProjects).insert({
    id: 'forged',
    name: 'drafted',
    // @ts-expect-error — draft inserts inherit the same trusted tenant scope
    workspaceId: 'beta',
  })
  // @ts-expect-error — draft updates cannot move a row between tenants
  void draft.from(schema.draftProjects).update({ workspaceId: 'beta' })
}

/** Revision tokens are allocated and advanced by WyStack on every mutation path. */
function revisionTokensCannotBeWritten() {
  const draft = tracked.withTenant('alpha').withDraft('draft-1')

  void tracked.into(schema.versionedProjects).insert({
    id: 'forged',
    name: 'versioned',
    // @ts-expect-error — revision tokens are allocated by the framework
    revision: 99,
  })
  // @ts-expect-error — revision tokens are advanced by the framework
  void tracked.from(schema.versionedProjects).update({ revision: 99 })
  void draft.into(schema.draftProjects).insert({
    id: 'forged',
    name: 'drafted',
    // @ts-expect-error — draft inserts cannot provide revision tokens
    revision: 99,
  })
  // @ts-expect-error — draft updates cannot provide revision tokens
  void draft.from(schema.draftProjects).update({ revision: 99 })
}

/** Returned rows expose managed fields with their domain types, but no invented fields. */
async function returnedRowsExposeManagedFields() {
  const row = await tracked
    .withTenant('alpha')
    .withDraft('draft-1')
    .from(schema.draftProjects)
    .first()
  if (!row) return

  const workspaceId: string = row.workspaceId
  const revision: number = row.revision
  void [workspaceId, revision]

  // @ts-expect-error — the selected-row contract is exact, not a string index signature
  void row.definitelyNotAColumn
}

// Keep the compile-time contracts reachable to the compiler without executing them.
void [
  applicationFieldsRemainWritable,
  tenantIdentityCannotBeWritten,
  revisionTokensCannotBeWritten,
  returnedRowsExposeManagedFields,
]

export type __SystemManagedInputContract = true
