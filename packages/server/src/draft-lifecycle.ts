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
import { compactLog, snapshotCommand, snapshotJsonValue } from './draft-command-log'
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
  assertStoredDraftIntegrity,
  deleteStoredCommands,
  deleteStoredTouchedTables,
  deleteStoredDraftAtRevision,
  ensureDraftStorage,
  insertStoredDraft,
  readStoredCommands,
  readStoredDraft,
  readStoredTouchedTables,
  refreshStoredDraftIntegrityAndAdvance,
  replaceStoredDraftBase,
  replaceStoredCommands,
  StoredDraftRevisionChangedError,
  upsertStoredTouchedTables,
  type StoredDraft,
} from './draft-store'
import {
  assertDraftRowsUnchanged,
  assertStoredDescriptorsCurrent,
  clearDerivedChanges,
  describeTouchedTables,
  enumerateTouchedCells,
  inspectDraftRows,
  recordCanonicalTouchedTables,
  recordTouchedTables,
} from './draft-review-state'

// oxlint-disable-next-line typescript/no-explicit-any -- polymorphic Drizzle table metadata
type AnyTable = any

const retryableTransactionCodes = new Set(['40P01', '40001'])
const maxTransactionAttempts = 3

function transactionErrorCode(error: unknown): string | undefined {
  let candidate = error
  const seen = new Set<unknown>()
  while (candidate && typeof candidate === 'object' && !seen.has(candidate)) {
    seen.add(candidate)
    const record = candidate as Record<string, unknown>
    if (typeof record['code'] === 'string') return record['code']
    candidate = record['cause']
  }
  return undefined
}

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

  // A draft with no tenant is "global". In a tenant-aware app that is a
  // privileged scope and only the host's explicit hook may grant it. In an app
  // with no tenant dimension every draft is app-scoped by construction, so the
  // hook is an optional extra gate rather than a requirement — demanding it
  // there would break every single-tenant app that used drafts before tenancy
  // existed.
  const globalDraftsArePrivileged = app.system.resolvesTenant || authorizeGlobalDraft !== undefined

  async function hasGlobalDraftAuthority(
    action: GlobalDraftAuthorizationRequest['action'],
    context: Record<string, unknown>,
    draft?: GlobalDraftAuthorizationRequest['draft'],
  ): Promise<boolean> {
    if (!globalDraftsArePrivileged) return true
    return (
      authorizeGlobalDraft !== undefined &&
      (await authorizeGlobalDraft({ action, draft, context })) === true
    )
  }

  async function requireStored(raw: DrizzleTracker['raw'], draftId: string): Promise<StoredDraft> {
    const draft = await readStoredDraft(raw, draftId)
    if (!draft) throw new Error(`draft lifecycle: unknown draft "${draftId}"`)
    return draft
  }

  /**
   * PostgreSQL can abort either participant when independently valid command
   * handlers acquire canonical rows in opposite orders. Retry only the whole,
   * framework-owned lifecycle transaction: command mutations are already
   * replayable by the draft contract, Actions are rejected, and invalidation is
   * emitted only after the final commit. Authorization, resolution, and
   * conflict-acceptance hooks remain outside this boundary.
   */
  async function runReplayableTransaction<T>(
    callback: (tx: DrizzleTracker) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= maxTransactionAttempts; attempt += 1) {
      try {
        return await app.system.createTracked().transaction(callback)
      } catch (error) {
        if (
          !retryableTransactionCodes.has(transactionErrorCode(error) ?? '') ||
          attempt === maxTransactionAttempts
        ) {
          throw error
        }
      }
    }
    throw new Error('draft lifecycle: unreachable transaction retry state')
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

  function assertAuthorizedSnapshot(current: StoredDraft, authorized: StoredDraft): void {
    if (
      !sameJsonValue(current.tenantId, authorized.tenantId) ||
      !sameJsonValue(current.ownerKey, authorized.ownerKey)
    ) {
      throw notFound(current.draftId)
    }
  }

  function scopeFromAuthorizedSnapshot(
    tracked: DrizzleTracker,
    authorized: StoredDraft,
  ): DrizzleTracker {
    return authorized.tenantId === undefined ? tracked : tracked.withTenant(authorized.tenantId)
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
      const authorizationTracker = app.system.createTracked()
      const authorized = await requireStored(authorizationTracker.raw, draftId)
      await authorizeTracker(authorizationTracker, authorized, context, 'append')
      let draftWrites = new Set<string>()
      let results: CommandResult[] | undefined
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          results = await runReplayableTransaction(async (tx) => {
            const stored = await requireStored(tx.raw, draftId)
            assertAuthorizedSnapshot(stored, authorized)
            const scopedTx = scopeFromAuthorizedSnapshot(tx, authorized)
            await assertStoredDraftIntegrity(tx.raw, draftId)
            const existingLog = await readStoredCommands(tx.raw, draftId)
            const touchedTables = new Map<string, AnyTable>()
            const draftDb = recordTouchedTables(scopedTx.withDraft(draftId), touchedTables)
            const attemptResults: CommandResult[] = []
            for (const snapshot of commands) {
              const definition = app.functions.get(snapshot.path)
              if (definition?.type === 'action') {
                throw new Error(`Draft command ${snapshot.path} cannot reference an action`)
              }
              const value = await app.system.runHandler(
                snapshot.path,
                snapshot.args,
                draftDb,
                context,
              )
              attemptResults.push({ id: snapshot.id, value })
            }

            const compactedLog = compactLog([...existingLog, ...commands])
            await replaceStoredCommands(tx.raw, draftId, compactedLog)
            await upsertStoredTouchedTables(
              tx.raw,
              draftId,
              describeTouchedTables(
                touchedTables,
                draftDb.tablesWritten,
                draftId,
                scopedTx.tenantId,
              ),
            )
            // The draft row is the final resource in every mutation. A losing
            // optimistic append rolls the whole attempt back and retries from
            // the newly committed log.
            await refreshStoredDraftIntegrityAndAdvance(tx.raw, draftId, stored.logRevision)
            draftWrites = new Set(draftDb.tablesWritten)
            return attemptResults
          })
          break
        } catch (error) {
          if (!(error instanceof StoredDraftRevisionChangedError) || attempt === 4) throw error
        }
      }
      if (!results) {
        throw new Error(`draft lifecycle: draft "${draftId}" changed concurrently`)
      }
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
      const result = await runReplayableTransaction(async (tx) => {
        const current = await requireStored(tx.raw, draftId)
        assertAuthorizedSnapshot(current, snapshot)
        const scopedTx = scopeFromAuthorizedSnapshot(tx, snapshot)
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
        const liveTables = new Map<string, AnyTable>()
        const committed = (await applyCommandsWithAuthorizedTx(app, boundLog, {
          mode: 'commit',
          context,
          tx: recordCanonicalTouchedTables(scopedTx, liveTables),
        })) as CommitResult
        await assertStoredDescriptorsCurrent(tx.raw, draftId, touched, liveTables)
        await validateGraph?.({
          phase: 'published',
          draftId,
          db: scopedTx,
          context,
        })
        await clearDerivedChanges(tx.raw, draftId)
        await deleteStoredCommands(tx.raw, draftId)
        await deleteStoredTouchedTables(tx.raw, draftId)
        const deleted = await deleteStoredDraftAtRevision(tx.raw, draftId, snapshot.logRevision)
        if (!deleted) {
          const latest = await readStoredDraft(tx.raw, draftId)
          if (!latest) throw notFound(draftId)
          throw new Error(`draft lifecycle: draft "${draftId}" changed during publish; retry`)
        }
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
      const authorizationTracker = app.system.createTracked()
      const authorized = await requireStored(authorizationTracker.raw, draftId)
      await authorizeTracker(authorizationTracker, authorized, context, 'discard')
      let draftWrites = new Set<string>()
      await runReplayableTransaction(async (tx) => {
        const stored = await requireStored(tx.raw, draftId)
        assertAuthorizedSnapshot(stored, authorized)
        const touched = await readStoredTouchedTables(tx.raw, draftId)
        await clearDerivedChanges(tx.raw, draftId)
        await deleteStoredCommands(tx.raw, draftId)
        await deleteStoredTouchedTables(tx.raw, draftId)
        draftWrites = new Set(
          touched.flatMap((table) => (table.invalidationTag ? [table.invalidationTag] : [])),
        )
        const deleted = await deleteStoredDraftAtRevision(tx.raw, draftId, authorized.logRevision)
        if (!deleted) {
          const latest = await readStoredDraft(tx.raw, draftId)
          if (!latest) throw notFound(draftId)
          throw new Error(`draft lifecycle: draft "${draftId}" changed during discard; retry`)
        }
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
      const snapshotTracked = app.system.createTracked()
      const snapshot = await requireStored(snapshotTracked.raw, draftId)
      const snapshotScoped = await authorizeTracker(snapshotTracked, snapshot, context, 'rebase')
      await assertStoredDraftIntegrity(snapshotScoped.raw, draftId)
      const log = await readStoredCommands(snapshotScoped.raw, draftId)
      const previousTouched = await readStoredTouchedTables(snapshotScoped.raw, draftId)
      const currentVersion = await versionProbe.current()
      const touchedCells = await enumerateTouchedCells(snapshotScoped.raw, draftId, previousTouched)
      const report: ConflictReport = {
        staleBase: versionProbe.isNewerThan(currentVersion, snapshot.baseVersion),
        overlappingCells:
          touchedCells.length > 0
            ? await versionProbe.cellsWrittenSince(snapshot.baseVersion, touchedCells)
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
      await runReplayableTransaction(async (tx) => {
        const stored = await requireStored(tx.raw, draftId)
        assertAuthorizedSnapshot(stored, snapshot)
        const scopedTx = scopeFromAuthorizedSnapshot(tx, snapshot)
        if (stored.logRevision !== snapshot.logRevision) {
          throw new Error(`draft lifecycle: draft "${draftId}" changed during rebase; retry`)
        }
        await assertStoredDraftIntegrity(tx.raw, draftId)
        await clearDerivedChanges(tx.raw, draftId)

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
        await deleteStoredTouchedTables(tx.raw, draftId)
        await upsertStoredTouchedTables(tx.raw, draftId, rebuiltTouched)
        await validateGraph?.({
          phase: 'effective',
          draftId,
          db: draftDb,
          context,
        })
        const confirmedVersion = await versionProbe.current()
        if (!sameJsonValue(confirmedVersion, currentVersion)) {
          throw new Error(
            `draft lifecycle: canonical version changed during rebase; retry draft "${draftId}"`,
          )
        }
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
