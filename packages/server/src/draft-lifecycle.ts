// @wystack/server — generic draft lifecycle (the third leg of the draft model)
//
// The draft system has three legs:
//   1. Read overlay  — `withDraft(draftId)` coalesce (canonical ⊕ delta). READ.
//   2. Write storage — central sparse JSONB row changes,
//                       written through the `withDraft` WRITE path (this PR's
//                       @wystack/db half) + a conservatively compacted command log.
//   3. Lifecycle (THIS) — open / append / publish / discard + conflict
//                          detection. Sits ABOVE the other two.
//
// This layer is GENERIC: it knows NOTHING about application artifacts. It speaks
// `Command` (an opaque `{path,args}` the engine dispatches), `(table, id)` cell
// coordinates, and an opaque `Version` token. The app conducts (opens drafts,
// drives append, chooses a conflict POLICY); this layer is the mechanism, a
// sibling to `applyCommands`/`transaction` with the same "app conducts" posture.
//
// PUBLISH = REPLAY THE
// ORDERED COMMAND LOG via `applyCommands(app, log, {commit})`, NOT "apply a
// row-delta onto canonical." The command log is the publish unit because it
// preserves INTENT GROUPING (e.g. an `add_to_dashboard` command merges into the
// dashboard node — a row-delta cannot reconstruct that). Central row changes
// are the READ overlay; the command log is the PUBLISH source. The
// two are different artifacts with different jobs.
//
// ATOMIC PUBLISH: `publish` adopts the `applyCommands` outer-tx seam
// to wrap command-log replay + derived-state sweep in ONE transaction.
// This eliminates the crash window that previously existed between "canonical
// committed" and "derived state cleared" — if either step fails, both roll back. The
// draft stays live and publish is retryable. This is the wystack-internal adoption
// of the primitive; an application's draft controller adopts separately
// (the durable-log delete is the analogous bookkeeping step there).

import type { DrizzleTracker } from '@wystack/db'
import { isPrincipal } from '@wystack/identity'
import {
  applyCommandsWithAuthorizedTx,
  type CommandResult,
  type CommitResult,
} from './apply-commands'
import {
  compactLog,
  snapshotCommand,
  snapshotJsonValue,
  type DraftCommand,
  type ResolveHook,
} from './draft-command-log'
export { compactLog } from './draft-command-log'
export type { DraftCommand, ResolveHook } from './draft-command-log'
import {
  type ConflictReport,
  type DraftAuthorizationRequest,
  type DraftLifecycle,
  type DraftLifecycleOptions,
  type GlobalDraftAuthorizationRequest,
} from './draft-lifecycle-types'
export { DraftConflictError, DraftIntegrityError } from './draft-lifecycle-types'
export type * from './draft-lifecycle-types'
import type { WyStackApp } from './create'
import {
  advanceStoredDraftRevision,
  assertStoredDraftIntegrity,
  deleteStoredTouchedTables,
  deleteStoredDraft,
  ensureDraftStorage,
  insertStoredDraft,
  readStoredCommands,
  readStoredDraft,
  readStoredTouchedTables,
  refreshStoredDraftIntegrity,
  replaceStoredDraftBase,
  replaceStoredCommands,
  upsertStoredTouchedTables,
  type StoredDraft,
} from './draft-store'
import {
  assertDraftRowsUnchanged,
  clearDerivedChanges,
  describeTouchedTables,
  enumerateTouchedCells,
  inspectDraftRows,
  recordTouchedTables,
} from './draft-review-state'

// oxlint-disable-next-line typescript/no-explicit-any -- polymorphic Drizzle table metadata
type AnyTable = any

let draftCounter = 0
function mintDraftId(): string {
  // Monotonic + random suffix: unique within a process without a uuid dep.
  draftCounter += 1
  return `draft_${Date.now().toString(36)}_${draftCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}

function defaultOwnerKey(context: Record<string, unknown>): unknown {
  const principal = context.principal
  if (principal === undefined || principal === null) return undefined
  if (!isPrincipal(principal)) {
    throw new Error(
      'draft lifecycle: context.principal must be a valid Principal or resolveOwner must be configured',
    )
  }
  return principal.kind === 'user'
    ? { kind: principal.kind, userId: principal.userId }
    : { kind: principal.kind, credentialId: principal.credentialId }
}

/**
 * Build the generic draft lifecycle over a WyStack app.
 *
 * @param app    the app whose function registry resolves command paths and whose
 *               connection backs both the derived writes and the publish replay.
 * @param opts.versionProbe  the ONLY app injection for conflict DETECTION; speaks
 *               `(table, id, version)` only. Omit it and `detectConflict` reports
 *               a no-conflict report (the app opted out of detection).
 */
export function createDraftLifecycle(
  app: WyStackApp,
  opts: DraftLifecycleOptions = {},
): DraftLifecycle {
  const { versionProbe, resolveOwner, authorizeDraft, authorizeGlobalDraft, validateGraph } = opts
  let storageInitialization: Promise<void> | undefined

  function storageReady(): Promise<void> {
    if (!storageInitialization) {
      const attempt = ensureDraftStorage(app.system.createTracked().raw)
      storageInitialization = attempt
      void attempt.catch(() => {
        if (storageInitialization === attempt) storageInitialization = undefined
      })
    }
    return storageInitialization
  }

  async function ownerKey(context: Record<string, unknown>): Promise<unknown | undefined> {
    const resolved = resolveOwner ? await resolveOwner(context) : defaultOwnerKey(context)
    if (resolved === undefined || resolved === null) return resolved
    return snapshotJsonValue(resolved, 'owner key')
  }

  function requireStableOwner(value: unknown): void {
    if (value === undefined || value === null) {
      throw new Error(
        'draft lifecycle: opening a draft requires a stable owner from context.principal or resolveOwner',
      )
    }
  }

  async function hasGlobalDraftAuthority(
    action: GlobalDraftAuthorizationRequest['action'],
    context: Record<string, unknown>,
    draft?: GlobalDraftAuthorizationRequest['draft'],
  ): Promise<boolean> {
    return (
      authorizeGlobalDraft !== undefined &&
      (await authorizeGlobalDraft({ action, draft, context })) === true
    )
  }

  async function requireStored(
    raw: DrizzleTracker['raw'],
    draftId: string,
    lock = false,
  ): Promise<StoredDraft> {
    const draft = await readStoredDraft(raw, draftId, lock)
    if (!draft) throw new Error(`draft lifecycle: unknown draft "${draftId}"`)
    return draft
  }

  function notFound(draftId: string): Error {
    return new Error(`draft lifecycle: unknown draft "${draftId}"`)
  }

  async function authorizeTracker(
    tracked: DrizzleTracker,
    draft: StoredDraft,
    context: Record<string, unknown>,
    action: DraftAuthorizationRequest['action'],
  ): Promise<DrizzleTracker> {
    let scoped: DrizzleTracker
    if (draft.tenantId === undefined) {
      if (
        !(await hasGlobalDraftAuthority(action, context, {
          draftId: draft.draftId,
          ownerKey: draft.ownerKey,
        }))
      ) {
        throw notFound(draft.draftId)
      }
      scoped = tracked
    } else {
      scoped = await app.system.scopeTracked(tracked, context)
      if (!sameJsonValue(scoped.tenantId, draft.tenantId)) {
        throw notFound(draft.draftId)
      }
    }
    if (draft.ownerKey === undefined || draft.ownerKey === null) throw notFound(draft.draftId)
    const currentOwner = await ownerKey(context)
    if (
      currentOwner !== undefined &&
      currentOwner !== null &&
      sameJsonValue(currentOwner, draft.ownerKey)
    ) {
      return scoped
    }
    if (authorizeDraft) {
      const allowed = await authorizeDraft({
        action,
        draft: {
          draftId: draft.draftId,
          tenantId: draft.tenantId,
          ownerKey: draft.ownerKey,
        },
        context,
      })
      if (allowed) return scoped
    }
    throw notFound(draft.draftId)
  }

  return {
    async open(baseVersion, openOpts = {}) {
      const context = openOpts.context ?? {}
      const resolvedOwnerKey = await ownerKey(context)
      requireStableOwner(resolvedOwnerKey)
      const unscoped = app.system.createTracked()
      const hasGlobalAuthority = await hasGlobalDraftAuthority('open', context)
      const scoped = hasGlobalAuthority
        ? unscoped
        : await app.system.scopeTracked(unscoped, context)
      if (scoped.tenantId === undefined && !hasGlobalAuthority) {
        throw new Error('draft lifecycle: global drafts require privileged host context')
      }
      await storageReady()
      const draftId = mintDraftId()
      await insertStoredDraft(scoped.raw, {
        draftId,
        baseVersion,
        tenantId: scoped.tenantId,
        ownerKey: resolvedOwnerKey,
      })
      return draftId
    },

    async append(draftId, batch, operationOpts = {}) {
      const commands = batch.map(snapshotCommand)
      await storageReady()
      const context = operationOpts.context ?? {}
      for (const command of commands) {
        const definition = app.functions.get(command.path)
        if (definition?.type === 'action') {
          throw new Error(`Draft command ${command.path} cannot reference an action`)
        }
      }
      const outer = app.system.createTracked()
      let draftWrites = new Set<string>()
      const results = await outer.transaction(async (tx) => {
        const stored = await requireStored(tx.raw, draftId, true)
        const scopedTx = await authorizeTracker(tx, stored, context, 'append')
        await assertStoredDraftIntegrity(tx.raw, draftId)
        const existingLog = await readStoredCommands(tx.raw, draftId)
        const touchedTables = new Map<string, AnyTable>()
        const draftDb = recordTouchedTables(scopedTx.withDraft(draftId), touchedTables)
        const results: CommandResult[] = []
        for (const snapshot of commands) {
          const definition = app.functions.get(snapshot.path)
          if (definition?.type === 'action') {
            throw new Error(`Draft command ${snapshot.path} cannot reference an action`)
          }
          const value = await app.system.runHandler(snapshot.path, snapshot.args, draftDb, context)
          results.push({ id: snapshot.id, value })
        }

        const compactedLog = compactLog([...existingLog, ...commands])
        await replaceStoredCommands(tx.raw, draftId, compactedLog)
        await upsertStoredTouchedTables(
          tx.raw,
          draftId,
          describeTouchedTables(touchedTables, draftDb.tablesWritten, draftId, scopedTx.tenantId),
        )
        await refreshStoredDraftIntegrity(tx.raw, draftId)
        await advanceStoredDraftRevision(tx.raw, draftId, stored.logRevision)
        draftWrites = new Set(draftDb.tablesWritten)
        return results
      })
      if (draftWrites.size > 0) app.system.emit(draftWrites)
      return results
    },

    async publish(draftId, resolve, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      const snapshotTracked = app.system.createTracked()
      const snapshot = await requireStored(snapshotTracked.raw, draftId)
      const snapshotScoped = await authorizeTracker(snapshotTracked, snapshot, context, 'publish')
      await assertStoredDraftIntegrity(snapshotScoped.raw, draftId)
      const snapshotLog = await readStoredCommands(snapshotScoped.raw, draftId)
      const boundLog = resolve
        ? (await resolve([...snapshotLog])).map((command) => snapshotCommand(command))
        : [...snapshotLog]

      let draftWrites = new Set<string>()
      const result = await app.system.createTracked().transaction(async (tx) => {
        const current = await requireStored(tx.raw, draftId, true)
        const scopedTx = await authorizeTracker(tx, current, context, 'publish')
        if (current.logRevision !== snapshot.logRevision) {
          throw new Error(`draft lifecycle: draft "${draftId}" changed during publish; retry`)
        }
        await assertStoredDraftIntegrity(tx.raw, draftId)
        const touched = await readStoredTouchedTables(tx.raw, draftId)
        await assertDraftRowsUnchanged(tx.raw, draftId, touched)
        await validateGraph?.({
          phase: 'effective',
          draftId,
          db: scopedTx.withDraft(draftId),
          context,
        })
        const committed = (await applyCommandsWithAuthorizedTx(app, boundLog, {
          mode: 'commit',
          context,
          tx: scopedTx,
        })) as CommitResult
        await validateGraph?.({
          phase: 'published',
          draftId,
          db: scopedTx,
          context,
        })
        await clearDerivedChanges(tx.raw, draftId)
        await deleteStoredDraft(tx.raw, draftId)
        draftWrites = new Set(
          touched.flatMap((table) => (table.invalidationTag ? [table.invalidationTag] : [])),
        )
        return committed
      })

      const tags = new Set([...result.tablesWritten, ...draftWrites])
      if (tags.size > 0) app.system.emit(tags)
      return result
    },

    async discard(draftId, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      let draftWrites = new Set<string>()
      await app.system.createTracked().transaction(async (tx) => {
        const stored = await requireStored(tx.raw, draftId, true)
        await authorizeTracker(tx, stored, context, 'discard')
        const touched = await readStoredTouchedTables(tx.raw, draftId)
        await clearDerivedChanges(tx.raw, draftId)
        await deleteStoredDraft(tx.raw, draftId)
        draftWrites = new Set(
          touched.flatMap((table) => (table.invalidationTag ? [table.invalidationTag] : [])),
        )
      })
      if (draftWrites.size > 0) app.system.emit(draftWrites)
    },

    async rebase(draftId, operationOpts = {}) {
      await storageReady()
      if (!versionProbe) {
        throw new Error('draft lifecycle: rebase requires a versionProbe')
      }
      const context = operationOpts.context ?? {}
      let emitted = new Set<string>()
      let report: ConflictReport = { staleBase: false, overlappingCells: [] }
      await app.system.createTracked().transaction(async (tx) => {
        const stored = await requireStored(tx.raw, draftId, true)
        const scopedTx = await authorizeTracker(tx, stored, context, 'rebase')
        await assertStoredDraftIntegrity(tx.raw, draftId)
        const log = await readStoredCommands(tx.raw, draftId)
        const previousTouched = await readStoredTouchedTables(tx.raw, draftId)
        const currentVersion = await versionProbe.current()
        const touchedCells = await enumerateTouchedCells(tx.raw, draftId, previousTouched)
        report = {
          staleBase: versionProbe.isNewerThan(currentVersion, stored.baseVersion),
          overlappingCells:
            touchedCells.length > 0
              ? await versionProbe.cellsWrittenSince(stored.baseVersion, touchedCells)
              : [],
        }
        if (report.overlappingCells.length > 0) {
          const accepted = operationOpts.acceptConflicts
            ? await operationOpts.acceptConflicts(report)
            : false
          if (!accepted) {
            throw new Error(`draft lifecycle: draft "${draftId}" has unresolved rebase conflicts`)
          }
        }
        await clearDerivedChanges(tx.raw, draftId)
        await deleteStoredTouchedTables(tx.raw, draftId)

        const touchedTables = new Map<string, AnyTable>()
        const draftDb = recordTouchedTables(scopedTx.withDraft(draftId), touchedTables)
        for (const command of log) {
          await app.system.runHandler(command.path, command.args, draftDb, context)
        }
        const rebuiltTouched = describeTouchedTables(
          touchedTables,
          draftDb.tablesWritten,
          draftId,
          scopedTx.tenantId,
        )
        await upsertStoredTouchedTables(tx.raw, draftId, rebuiltTouched)
        await validateGraph?.({
          phase: 'effective',
          draftId,
          db: draftDb,
          context,
        })
        await refreshStoredDraftIntegrity(tx.raw, draftId)
        await replaceStoredDraftBase(tx.raw, draftId, currentVersion, stored.logRevision)
        emitted = new Set([
          ...previousTouched.flatMap((table) =>
            table.invalidationTag ? [table.invalidationTag] : [],
          ),
          ...draftDb.tablesWritten,
        ])
      })
      if (emitted.size > 0) app.system.emit(emitted)
      return report
    },

    async detectConflict(draftId, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      const stored = await requireStored(app.system.createTracked().raw, draftId)
      const scoped = await authorizeTracker(
        app.system.createTracked(),
        stored,
        context,
        'detectConflict',
      )
      await assertStoredDraftIntegrity(scoped.raw, draftId)
      if (!versionProbe) {
        // No probe ⇒ detection opted out. Report no conflict (the app chose not
        // to track canonical versions).
        return { staleBase: false, overlappingCells: [] }
      }

      const current = await versionProbe.current()
      const staleBase = versionProbe.isNewerThan(current, stored.baseVersion)

      // Fine signal: enumerate THIS draft's touched cells from central changes,
      // then ask the probe which canonical also
      // wrote at/after base. Reading derived identities keeps detection artifact-blind.
      const touched = await readStoredTouchedTables(scoped.raw, draftId)
      const touchedCells = await enumerateTouchedCells(scoped.raw, draftId, touched)
      const overlappingCells =
        touchedCells.length > 0
          ? await versionProbe.cellsWrittenSince(stored.baseVersion, touchedCells)
          : []

      return { staleBase, overlappingCells }
    },

    async inspect(draftId, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      const stored = await requireStored(app.system.createTracked().raw, draftId)
      const scoped = await authorizeTracker(app.system.createTracked(), stored, context, 'inspect')
      await assertStoredDraftIntegrity(scoped.raw, draftId)
      return inspectDraftRows(scoped.raw, draftId)
    },

    async getLog(draftId, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      const stored = await requireStored(app.system.createTracked().raw, draftId)
      const scoped = await authorizeTracker(app.system.createTracked(), stored, context, 'getLog')
      return readStoredCommands(scoped.raw, draftId)
    },
  }
}
