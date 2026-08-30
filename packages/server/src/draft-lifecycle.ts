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
// PUBLISH verifies that the ordered command log still materializes the reviewed
// row changes, then applies those exact changes. The log resolves handler code
// and table objects; the stored changes and their anchors remain authoritative.
//
// ATOMIC PUBLISH wraps verification + canonical changes + derived-state sweep
// in ONE transaction.
// This eliminates the crash window that previously existed between "canonical
// committed" and "derived state cleared" — if either step fails, both roll back. The
// draft stays live and publish is retryable. This is the wystack-internal adoption
// of the primitive; an application's draft controller adopts separately
// (the durable-log delete is the analogous bookkeeping step there).

import { createDrizzleTracker, type DrizzleTracker, type SelectBuilder } from '@wystack/db'
import { isPrincipal } from '@wystack/identity'
import { sql } from 'drizzle-orm'
import { assertReplayableCommand, type CommandResult, type CommitResult } from './apply-commands'
import {
  compactLog,
  snapshotCommand,
  snapshotJsonValue,
  type DraftCommand,
} from './draft-command-log'
import { snapshotDraftSummary } from './draft-summary'
export { compactLog } from './draft-command-log'
export type { DraftCommand, ResolveHook } from './draft-command-log'
import {
  type ConflictReport,
  type DraftAuthorizationRequest,
  type DraftGraphReadBuilder,
  type DraftGraphReadTracker,
  type DraftLifecycle,
  type DraftLifecycleOptions,
  type DraftMetadataSnapshot,
  type DraftSummary,
  type ForkResolution,
  type GlobalDraftAuthorizationRequest,
  type OwnedDraftSummary,
  type Version,
} from './draft-lifecycle-types'
export {
  DEFAULT_OWNED_DRAFT_PAGE_SIZE,
  MAX_DRAFT_LOOKUP_KEY_BYTES,
  MAX_DRAFT_SUMMARY_BYTES,
  MAX_DRAFT_SUMMARY_DEPTH,
  MAX_OWNED_DRAFT_PAGE_SIZE,
  DraftConflictError,
  DraftIntegrityError,
  DraftPublishDriftError,
} from './draft-lifecycle-types'
export type * from './draft-lifecycle-types'
import type { WyStackApp } from './create'
import {
  assertStoredDraftIntegrity,
  deleteStoredCommands,
  deleteStoredTouchedTables,
  deleteStoredDraftAtRevision,
  ensureDraftStorage,
  findStoredDraftForOwnerByLookupKey,
  insertStoredDraft,
  listStoredDraftsForOwner,
  lockStoredDraftLookup,
  readStoredCommands,
  readStoredDraft,
  readStoredTouchedTables,
  refreshStoredDraftIntegrityAndAdvance,
  replaceStoredDraftBase,
  replaceStoredCommands,
  StoredDraftRevisionChangedError,
  upsertStoredTouchedTables,
  validateDraftLookupKey,
  type StoredDraft,
  type StoredDraftSummary,
} from './draft-store'
import {
  applyReviewedChanges,
  assertDraftRowsUnchanged,
  assertReplayMatchesReviewedChanges,
  assertStoredDescriptorsCurrent,
  clearDerivedChanges,
  describeTouchedTables,
  enumerateTouchedCells,
  inspectDraftRows,
  recordTouchedTables,
} from './draft-review-state'
import { stableJson } from './stable-json'

type AnyTable = Parameters<DrizzleTracker['from']>[0]

type SummaryReplacement = { replace: false } | { replace: true; summary: DraftSummary }

function snapshotSummaryReplacement(
  value: { summary?: DraftSummary },
  path: string,
): SummaryReplacement {
  if (!Object.hasOwn(value, 'summary')) return { replace: false }
  return { replace: true, summary: snapshotDraftSummary(value.summary, path) }
}

function toOwnedDraftSummary(draft: StoredDraftSummary): OwnedDraftSummary {
  return {
    draftId: draft.draftId,
    baseVersion: draft.baseVersion,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    ...(draft.lookupKey === undefined ? {} : { lookupKey: draft.lookupKey }),
    ...(draft.summary === undefined ? {} : { summary: draft.summary }),
    cursor: draft.cursor,
  }
}

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

async function lockDraftForPublication(raw: DrizzleTracker['raw'], draftId: string): Promise<void> {
  await raw.execute(sql`
    SELECT pg_advisory_xact_lock(hashtext('wystack publish'), hashtext(${draftId}))
  `)
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

type ValidationReadBuilder = {
  select(...columns: string[]): ValidationReadBuilder
  where(filters: Parameters<DraftGraphReadBuilder<AnyTable>['where']>[0]): ValidationReadBuilder
  includeDeleted(): ValidationReadBuilder
  onlyDeleted(): ValidationReadBuilder
  orderBy(column: string, direction?: 'asc' | 'desc'): ValidationReadBuilder
  limit(count: number): ValidationReadBuilder
  all(): Promise<unknown[]>
  first(): Promise<unknown | null>
  toSql(limitOverride?: number): ReturnType<DraftGraphReadBuilder<AnyTable>['toSql']>
}
type ValidationRow<TTable extends AnyTable> = Awaited<
  ReturnType<SelectBuilder<TTable>['all']>
>[number]

/**
 * Narrow a transaction-bound tracker to an object-capability that can only
 * build reads. Wrapping each returned builder matters: omitting `into()` from
 * the tracker alone would still leave `from(table).update()` available at
 * runtime to JavaScript callers or code using a cast.
 */
function graphReadTracker(
  db: DrizzleTracker | ReturnType<DrizzleTracker['withDraft']>,
): DraftGraphReadTracker {
  function wrapBuilder<TTable extends AnyTable, TRow = ValidationRow<TTable>>(
    builder: ValidationReadBuilder,
  ): DraftGraphReadBuilder<TTable, TRow> {
    const readBuilder: DraftGraphReadBuilder<TTable, TRow> = {
      select<K extends keyof ValidationRow<TTable> & string>(...columns: [K, ...K[]]) {
        return wrapBuilder<TTable, Pick<ValidationRow<TTable>, K>>(builder.select(...columns))
      },
      where: (filters) => wrapBuilder<TTable, TRow>(builder.where(filters)),
      includeDeleted: () => wrapBuilder<TTable, TRow>(builder.includeDeleted()),
      onlyDeleted: () => wrapBuilder<TTable, TRow>(builder.onlyDeleted()),
      orderBy: (column, direction) => wrapBuilder<TTable, TRow>(builder.orderBy(column, direction)),
      limit: (count) => wrapBuilder<TTable, TRow>(builder.limit(count)),
      all: () => builder.all() as Promise<TRow[]>,
      first: () => builder.first() as Promise<TRow | null>,
      toSql: (limitOverride) => builder.toSql(limitOverride),
    }
    return Object.freeze(readBuilder)
  }

  const readTracker: DraftGraphReadTracker = {
    from: <TTable extends AnyTable>(table: TTable) =>
      wrapBuilder<TTable>(db.from(table) as unknown as ValidationReadBuilder),
  }
  return Object.freeze(readTracker)
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

  function assertDraftCommandIsReplayable(command: DraftCommand): void {
    assertReplayableCommand(app.functions.get(command.path), command.path, 'Draft command')
  }

  async function runDraftCommand(
    command: DraftCommand,
    db: Parameters<WyStackApp['system']['runHandler']>[2],
    context: Record<string, unknown>,
  ): Promise<unknown> {
    // The registry is mutable. Check immediately before dispatch so an earlier
    // command cannot replace a later path with an ineligible definition.
    assertDraftCommandIsReplayable(command)
    return app.system.runHandler(command.path, command.args, db, context)
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
   * framework-owned lifecycle transaction: explicit command handlers attest
   * replay safety, ineligible definitions are rejected, and invalidation is
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

  function snapshotInitialCommands(batch: DraftCommand[]): DraftCommand[] {
    const commands = batch.map(snapshotCommand)
    if (commands.length === 0) {
      throw new Error('draft lifecycle: opening with commands requires a non-empty batch')
    }
    for (const command of commands) assertDraftCommandIsReplayable(command)
    return commands
  }

  async function resolveDraftCustody(
    action: 'open' | 'listOwned' | 'findOwnedByLookupKey',
    context: Record<string, unknown>,
  ): Promise<{
    tracked: DrizzleTracker
    ownerKey: unknown
  }> {
    const resolvedOwnerKey = await ownerKey(context)
    requireStableOwner(resolvedOwnerKey)
    const unscoped = app.system.createTracked()
    const hasGlobalAuthority = await hasGlobalDraftAuthority(action, context)
    const tracked = hasGlobalAuthority ? unscoped : await app.system.scopeTracked(unscoped, context)
    if (tracked.tenantId === undefined && !hasGlobalAuthority) {
      throw new Error('draft lifecycle: global drafts require privileged host context')
    }
    return { tracked, ownerKey: resolvedOwnerKey }
  }

  async function materializeOpenedDraft(
    tx: DrizzleTracker,
    input: {
      draftId: string
      baseVersion: Version
      tenantId: unknown | undefined
      ownerKey: unknown
      lookupKey: string | undefined
      summary: DraftSummary | undefined
      commands: DraftCommand[]
      context: Record<string, unknown>
    },
  ): Promise<{ results: CommandResult[]; draftWrites: Set<string> }> {
    const scopedTx = input.tenantId === undefined ? tx : tx.withTenant(input.tenantId)
    await insertStoredDraft(tx.raw, {
      draftId: input.draftId,
      baseVersion: input.baseVersion,
      tenantId: input.tenantId,
      ownerKey: input.ownerKey,
      lookupKey: input.lookupKey,
      summary: input.summary,
    })

    const touchedTables = new Map<string, AnyTable>()
    const draftDb = recordTouchedTables(scopedTx.withDraft(input.draftId), touchedTables)
    const results: CommandResult[] = []
    for (const command of input.commands) {
      const value = await runDraftCommand(command, draftDb, input.context)
      results.push({ id: command.id, value })
    }

    await replaceStoredCommands(tx.raw, input.draftId, compactLog(input.commands))
    await upsertStoredTouchedTables(
      tx.raw,
      input.draftId,
      describeTouchedTables(touchedTables, draftDb.tablesWritten, input.draftId, scopedTx.tenantId),
    )
    await refreshStoredDraftIntegrityAndAdvance(tx.raw, input.draftId, 0)
    return { results, draftWrites: new Set(draftDb.tablesWritten) }
  }

  return {
    async open(baseVersion, openOpts = {}) {
      const lookupKey =
        openOpts.lookupKey === undefined ? undefined : validateDraftLookupKey(openOpts.lookupKey)
      const initialSummary = snapshotSummaryReplacement(openOpts, 'draft summary')
      const context = openOpts.context ?? {}
      const custody = await resolveDraftCustody('open', context)
      await storageReady()
      const draftId = mintDraftId()
      await insertStoredDraft(custody.tracked.raw, {
        draftId,
        baseVersion,
        tenantId: custody.tracked.tenantId,
        ownerKey: custody.ownerKey,
        lookupKey,
        summary: initialSummary.replace ? initialSummary.summary : undefined,
      })
      return draftId
    },

    async openWithCommands(baseVersion, batch, openOpts = {}) {
      const commands = snapshotInitialCommands(batch)
      const lookupKey =
        openOpts.lookupKey === undefined ? undefined : validateDraftLookupKey(openOpts.lookupKey)
      const initialSummary = snapshotSummaryReplacement(openOpts, 'draft summary')
      const context = openOpts.context ?? {}
      const custody = await resolveDraftCustody('open', context)
      await storageReady()

      const draftId = mintDraftId()
      const opened = await runReplayableTransaction((tx) =>
        materializeOpenedDraft(tx, {
          draftId,
          baseVersion,
          tenantId: custody.tracked.tenantId,
          ownerKey: custody.ownerKey,
          lookupKey,
          summary: initialSummary.replace ? initialSummary.summary : undefined,
          commands,
          context,
        }),
      )

      if (opened.draftWrites.size > 0) app.system.emit(opened.draftWrites)
      return { draftId, results: opened.results }
    },

    async getOrOpenWithCommands(baseVersion, batch, openOpts) {
      const commands = snapshotInitialCommands(batch)
      const lookupKey = validateDraftLookupKey(openOpts.lookupKey)
      const initialSummary = snapshotSummaryReplacement(openOpts, 'draft summary')
      const context = openOpts.context ?? {}
      const custody = await resolveDraftCustody('open', context)
      await storageReady()

      const candidateDraftId = mintDraftId()
      const outcome = await runReplayableTransaction(async (tx) => {
        await lockStoredDraftLookup(tx.raw, custody.tracked.tenantId, custody.ownerKey, lookupKey)
        const existing = await findStoredDraftForOwnerByLookupKey(
          tx.raw,
          custody.tracked.tenantId,
          custody.ownerKey,
          lookupKey,
        )
        if (existing) {
          return {
            created: false,
            draftId: existing.draftId,
            results: [] as CommandResult[],
            draftWrites: new Set<string>(),
          }
        }

        const opened = await materializeOpenedDraft(tx, {
          draftId: candidateDraftId,
          baseVersion,
          tenantId: custody.tracked.tenantId,
          ownerKey: custody.ownerKey,
          lookupKey,
          summary: initialSummary.replace ? initialSummary.summary : undefined,
          commands,
          context,
        })
        return { created: true, draftId: candidateDraftId, ...opened }
      })

      if (outcome.draftWrites.size > 0) app.system.emit(outcome.draftWrites)
      return {
        created: outcome.created,
        draftId: outcome.draftId,
        results: outcome.results,
      }
    },

    async listOwned(listOpts = {}) {
      const context = listOpts.context ?? {}
      const scope = await resolveDraftCustody('listOwned', context)
      await storageReady()
      const drafts = await listStoredDraftsForOwner(
        scope.tracked.raw,
        scope.tracked.tenantId,
        scope.ownerKey,
        { limit: listOpts.limit, cursor: listOpts.cursor },
      )
      return drafts.map(toOwnedDraftSummary)
    },

    async findOwnedByLookupKey(lookupKey, operationOpts = {}) {
      const normalizedLookupKey = validateDraftLookupKey(lookupKey)
      const context = operationOpts.context ?? {}
      const scope = await resolveDraftCustody('findOwnedByLookupKey', context)
      await storageReady()
      const draft = await findStoredDraftForOwnerByLookupKey(
        scope.tracked.raw,
        scope.tracked.tenantId,
        scope.ownerKey,
        normalizedLookupKey,
      )
      return draft ? toOwnedDraftSummary(draft) : undefined
    },

    async append(draftId, batch, operationOpts = {}) {
      const commands = batch.map(snapshotCommand)
      const summaryReplacement = snapshotSummaryReplacement(operationOpts, 'draft summary')
      await storageReady()
      const context = operationOpts.context ?? {}
      for (const command of commands) {
        assertDraftCommandIsReplayable(command)
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
              const value = await runDraftCommand(snapshot, draftDb, context)
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
            await refreshStoredDraftIntegrityAndAdvance(
              tx.raw,
              draftId,
              stored.logRevision,
              summaryReplacement.replace ? { summary: summaryReplacement.summary } : {},
            )
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
      for (const command of boundLog) {
        assertDraftCommandIsReplayable(command)
      }

      let draftWrites = new Set<string>()
      const result = await runReplayableTransaction(async (tx) => {
        // Only publishers share this mutex. Append remains free to advance the
        // draft while graph validation runs, and the final revision CAS then
        // rejects this stale attempt without making a host callback hold locks.
        await lockDraftForPublication(tx.raw, draftId)
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
          db: graphReadTracker(scopedTx.withDraft(draftId)),
          context,
        })
        const replayDraftId = `${draftId}:publish:${mintDraftId()}`
        const liveTables = new Map<string, AnyTable>()
        const replayDb = recordTouchedTables(scopedTx.withDraft(replayDraftId), liveTables)
        const results: CommandResult[] = []
        for (const command of boundLog) {
          const value = await runDraftCommand(command, replayDb, context)
          results.push({ id: command.id, value })
        }
        await assertStoredDescriptorsCurrent(tx.raw, draftId, touched, liveTables)
        await assertReplayMatchesReviewedChanges(tx.raw, draftId, replayDraftId)
        await clearDerivedChanges(tx.raw, replayDraftId)

        const canonicalTx = scopeFromAuthorizedSnapshot(createDrizzleTracker(tx.raw), snapshot)
        await applyReviewedChanges(canonicalTx, draftId, liveTables)
        const committed: CommitResult = {
          mode: 'commit',
          commands: boundLog,
          results,
          tablesWritten: new Set(canonicalTx.tablesWritten),
        }
        await validateGraph?.({
          phase: 'published',
          draftId,
          db: graphReadTracker(canonicalTx),
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

    async forkAndDiscard(draftId, baseVersion, resolve, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      const snapshotTracked = app.system.createTracked()
      const snapshot = await requireStored(snapshotTracked.raw, draftId)
      const snapshotScoped = await authorizeTracker(
        snapshotTracked,
        snapshot,
        context,
        'forkAndDiscard',
      )
      await assertStoredDraftIntegrity(snapshotScoped.raw, draftId)
      const snapshotLog = await readStoredCommands(snapshotScoped.raw, draftId)
      const resolverMetadata: DraftMetadataSnapshot = {
        ...(snapshot.lookupKey === undefined ? {} : { lookupKey: snapshot.lookupKey }),
        ...(snapshot.summary === undefined
          ? {}
          : {
              summary: snapshotDraftSummary(snapshot.summary, 'draft summary'),
            }),
      }
      const resolved = await resolve([...snapshotLog], resolverMetadata)
      let commands: DraftCommand[]
      let summaryReplacement: SummaryReplacement
      if (Array.isArray(resolved)) {
        commands = resolved
        summaryReplacement = { replace: false }
      } else {
        if (!resolved || typeof resolved !== 'object' || !Array.isArray(resolved.commands)) {
          throw new Error(
            'draft lifecycle: fork resolver must return commands or a { commands, summary? } object',
          )
        }
        commands = resolved.commands
        summaryReplacement = snapshotSummaryReplacement(resolved as ForkResolution, 'draft summary')
      }
      const replacementLog = compactLog(commands.map((command) => snapshotCommand(command)))
      for (const command of replacementLog) assertDraftCommandIsReplayable(command)
      const replacementSummary = summaryReplacement.replace
        ? summaryReplacement.summary
        : snapshot.summary

      const replacementId = mintDraftId()
      let emitted = new Set<string>()
      await runReplayableTransaction(async (tx) => {
        const current = await requireStored(tx.raw, draftId)
        assertAuthorizedSnapshot(current, snapshot)
        if (current.logRevision !== snapshot.logRevision) {
          throw new Error(`draft lifecycle: draft "${draftId}" changed during replacement; retry`)
        }
        await assertStoredDraftIntegrity(tx.raw, draftId)

        const scopedTx = scopeFromAuthorizedSnapshot(tx, snapshot)
        await insertStoredDraft(tx.raw, {
          draftId: replacementId,
          baseVersion,
          tenantId: snapshot.tenantId,
          ownerKey: snapshot.ownerKey,
          lookupKey: snapshot.lookupKey,
          summary: replacementSummary,
        })
        const touchedTables = new Map<string, AnyTable>()
        const replacementDb = recordTouchedTables(scopedTx.withDraft(replacementId), touchedTables)
        for (const command of replacementLog) {
          await runDraftCommand(command, replacementDb, context)
        }
        await replaceStoredCommands(tx.raw, replacementId, replacementLog)
        const replacementTouched = describeTouchedTables(
          touchedTables,
          replacementDb.tablesWritten,
          replacementId,
          scopedTx.tenantId,
        )
        await upsertStoredTouchedTables(tx.raw, replacementId, replacementTouched)
        await validateGraph?.({
          phase: 'effective',
          draftId: replacementId,
          db: graphReadTracker(replacementDb),
          context,
        })
        await refreshStoredDraftIntegrityAndAdvance(tx.raw, replacementId, 0)

        const previousTouched = await readStoredTouchedTables(tx.raw, draftId)
        await clearDerivedChanges(tx.raw, draftId)
        await deleteStoredCommands(tx.raw, draftId)
        await deleteStoredTouchedTables(tx.raw, draftId)
        const deleted = await deleteStoredDraftAtRevision(tx.raw, draftId, snapshot.logRevision)
        if (!deleted) {
          const latest = await readStoredDraft(tx.raw, draftId)
          if (!latest) throw notFound(draftId)
          throw new Error(`draft lifecycle: draft "${draftId}" changed during replacement; retry`)
        }

        emitted = new Set([
          ...previousTouched.flatMap((table) =>
            table.invalidationTag ? [table.invalidationTag] : [],
          ),
          ...replacementDb.tablesWritten,
        ])
      })
      if (emitted.size > 0) app.system.emit(emitted)
      return replacementId
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
      // Reconfirm after every host callback, before opening the transaction.
      // Once replay starts, its row locks and the stored-draft revision CAS are
      // the database-local guard; no external probe runs while those locks are held.
      const confirmedVersion = await versionProbe.current()
      if (!sameJsonValue(confirmedVersion, currentVersion)) {
        throw new Error(
          `draft lifecycle: canonical version changed during rebase; retry "${draftId}"`,
        )
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
          await runDraftCommand(command, draftDb, context)
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
          db: graphReadTracker(draftDb),
          context,
        })
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
