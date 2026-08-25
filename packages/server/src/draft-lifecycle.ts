// @wystack/server — generic draft lifecycle (the third leg of the draft model)
//
// The draft system has three legs:
//   1. Read overlay  — `withDraft(draftId)` coalesce (canonical ⊕ delta). READ.
//   2. Write storage — central sparse JSONB row changes,
//                       written through the `withDraft` WRITE path (this PR's
//                       @wystack/db half) + a bounded, compacted command log.
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

import {
  draftInvalidationIdentity,
  tryGetTableCapabilities,
  resolvePkColumnName,
  type DraftDrizzleTracker,
  type DrizzleTracker,
} from '@wystack/db'
import { isPrincipal } from '@wystack/identity'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import {
  applyCommands,
  type Command,
  type CommandResult,
  type CommitResult,
} from './apply-commands'
import type { WyStackApp } from './create'
import {
  advanceStoredDraftRevision,
  deleteStoredTouchedTables,
  deleteStoredDraft,
  ensureDraftStorage,
  insertStoredDraft,
  readStoredCommands,
  readStoredDraft,
  readStoredTouchedTables,
  replaceStoredDraftBase,
  replaceStoredCommands,
  upsertStoredTouchedTables,
  type StoredDraft,
  type StoredTouchedTable,
} from './draft-store'

// oxlint-disable-next-line typescript/no-explicit-any -- polymorphic Drizzle table, mirrors drizzle-tracker.ts
type AnyTable = any

/**
 * A `(table, id)` pair — one CELL the draft touched or canonical wrote. The
 * lifecycle's conflict detection speaks only this and an opaque `Version`; it
 * carries ZERO artifact-type knowledge. `id` is the row's primary-key value,
 * `table` its schema-qualified SQL identity when a non-default schema exists.
 */
export interface Cell {
  table: string
  id: unknown
}

/**
 * Opaque snapshot token for the canonical store, supplied by the app at `open`
 * and compared by the app-injected `VersionProbe`. The lifecycle NEVER inspects
 * it — it is a black box passed from `open(baseVersion)` to the probe at
 * `detectConflict`. The app decides what a version is (a global monotonic
 * counter, an LSN, a max(updated_at), …); the lifecycle stays generic.
 */
export type Version = unknown

/**
 * The ONLY app-injected dependency of conflict DETECTION. It speaks `(table, id,
 * version)` exclusively, so the lifecycle stays artifact-agnostic: the app backs
 * it however it tracks canonical writes (an audit log, a per-row version column,
 * a global counter), and the lifecycle just asks two questions.
 *
 * Detection is mechanism only — it reports the two generic signals. The POLICY
 * (rebase vs block vs route-to-repair) is the app's call (a single branch on the
 * signal), NOT here.
 */
export interface VersionProbe {
  /** The canonical store's CURRENT version. Compared against a draft's base. */
  current(): Promise<Version>
  /**
   * True iff `current` is strictly newer than `base` — i.e. canonical advanced
   * under the draft. Backs the COARSE `staleBase` signal. Kept on the probe (not
   * a generic comparator) because only the app knows how to order its tokens.
   */
  isNewerThan(current: Version, base: Version): boolean
  /**
   * Of the supplied `cells` (the cells THIS draft touched), return the subset
   * canonical ALSO wrote at or after `base`. Backs the FINE `overlappingCells`
   * signal. An empty result means the draft and canonical touched disjoint
   * cells — safe to publish without rebase even if `staleBase` is true.
   */
  cellsWrittenSince(base: Version, cells: Cell[]): Promise<Cell[]>
}

/** The generic conflict signal — two coordinates, zero artifact knowledge. */
export interface ConflictReport {
  /**
   * COARSE: canonical advanced past the draft's base version. True does NOT by
   * itself mean the publish is unsafe (canonical may have touched disjoint
   * cells) — it is the cheap "something moved" tripwire.
   */
  staleBase: boolean
  /**
   * FINE: the draft-touched cells canonical ALSO wrote at/after the draft's
   * base. A non-empty list is a genuine overlap — the app's policy decides what
   * to do (rebase, block, route to repair). Empty + `staleBase` true = moved but
   * disjoint.
   */
  overlappingCells: Cell[]
}

export interface DraftRowConflict {
  table: string
  id: unknown
  reason: 'created' | 'deleted' | 'revision'
}

export class DraftConflictError extends Error {
  readonly conflicts: DraftRowConflict[]

  constructor(draftId: string, conflicts: DraftRowConflict[]) {
    super(`draft lifecycle: draft "${draftId}" conflicts with published data`)
    this.name = 'DraftConflictError'
    this.conflicts = conflicts
  }
}

export interface OpenOptions {
  /** Current request context used to bind tenant and owner custody. Never persisted. */
  context?: Record<string, unknown>
}

export interface DraftOperationOptions {
  /** Current request context. Authorization is re-evaluated on every operation. */
  context?: Record<string, unknown>
}

export interface RebaseOptions extends DraftOperationOptions {
  acceptConflicts?: (report: ConflictReport) => boolean | Promise<boolean>
}

export interface DraftLifecycleOptions {
  versionProbe?: VersionProbe
  /** Resolve the stable owner/custodian key. Defaults to the Principal's kind and stable ID. */
  resolveOwner?: (context: Record<string, unknown>) => unknown | Promise<unknown>
  /** Override owner-only access for explicit collaboration/product policy. Tenant scope still applies. */
  authorizeDraft?: (request: DraftAuthorizationRequest) => boolean | Promise<boolean>
  /** Application-owned cross-row validation, run inside publish/rebase transactions. */
  validateGraph?: (request: DraftGraphValidationRequest) => void | Promise<void>
}

export interface DraftGraphValidationRequest {
  phase: 'effective' | 'published'
  draftId: string
  db: DrizzleTracker | DraftDrizzleTracker
  context: Record<string, unknown>
}

export interface DraftAuthorizationRequest {
  action: 'append' | 'publish' | 'discard' | 'rebase' | 'detectConflict' | 'inspect' | 'getLog'
  draft: {
    draftId: string
    tenantId: unknown | undefined
    ownerKey: unknown | undefined
  }
  context: Record<string, unknown>
}

export interface DraftInspectionRow {
  draftId: string
  table: string
  tenantKey: unknown
  rowKey: unknown
  operation: 'insert' | 'update' | 'delete'
  baseExists: boolean
  baseRevision: unknown
  fields: Record<
    string,
    {
      original: DraftInspectionValue
      value: DraftInspectionValue
    }
  >
}

export type DraftInspectionValue =
  | { kind: 'absent' }
  | { kind: 'sql-null' }
  | { kind: 'json'; value: unknown }
  | { kind: 'value'; value: unknown }

export interface DraftLifecycle {
  /** Open a draft over a base snapshot. Returns the new draft id. */
  open(baseVersion: Version, opts?: OpenOptions): Promise<string>
  /**
   * Apply a batch of commands INSIDE the draft: routes each command's writes
   * into the central derived overlay (via `withDraft`'s write path) and appends
   * them to the command log. Reads inside the handler see `canonical ⊕ draft`.
   * Returns the per-command results (same shape as `applyCommands`).
   *
   * The overlay writes, compacted command log, touched-table metadata, and log
   * revision update share one row-locked transaction. A failed batch leaves no
   * partial overlay or log state.
   *
   * `batch` is `DraftCommand[]` so the optional `compactionKey`/`kind` fields
   * are discoverable at the call site — an app that wants net-effect log
   * compaction mints those; a plain `Command` (no key) is never compacted.
   *
   * Concurrency: the persisted draft row serializes appends, so two processes
   * cannot interleave overlay writes or log positions.
   */
  append(
    draftId: string,
    batch: DraftCommand[],
    opts?: DraftOperationOptions,
  ): Promise<CommandResult[]>
  /**
   * PUBLISH = replay the ordered command log onto canonical via
   * `applyCommands(app, log, {commit})`, calling `resolve(log)` IMMEDIATELY
   * before the commit (the ONLY app injection inside publish — it binds
   * late-bound operands). Atomic via `applyCommands`'s tracked tx. The
   * draft's derived changes, command log, and metadata are cleared on success.
   *
   * Invalidation is the LIFECYCLE's job, not the host's: publish emits the
   * canonical tags from the replay plus virtual per-table draft tags for the sweep
   * (untracked, so `applyCommands` cannot report them), once the transaction has
   * durably committed. `append` and `discard` emit too — every entry point that
   * writes announces its own writes, so no consumer can forget to and leave
   * subscriptions silently stale. `tablesWritten` is still returned for hosts
   * that want the set for their own bookkeeping.
   *
   * The resolve hook runs outside the transaction. Publish then row-locks the
   * draft and compares its persisted log revision; an append during resolution
   * advances that revision and makes this attempt fail for a safe retry. Replay,
   * derived-state sweep, and metadata/log deletion share the locked transaction.
   */
  publish(
    draftId: string,
    resolve?: ResolveHook,
    opts?: DraftOperationOptions,
  ): Promise<CommitResult>
  /**
   * Drop the draft: row-lock its metadata, clear every persisted touched-table
   * derived state, and delete its command log and metadata in one transaction.
   */
  discard(draftId: string, opts?: DraftOperationOptions): Promise<void>
  /** Explicitly replay the log over newer canonical data after application conflict policy. */
  rebase(draftId: string, opts?: RebaseOptions): Promise<ConflictReport>
  /**
   * Detect whether canonical moved under the draft. Returns the two generic
   * signals; makes NO policy decision. Reads the draft's touched cells straight
   * from central changes (the `(draftId, tableKey, rowKey)` keys), then asks the
   * app's `VersionProbe` which canonical also wrote.
   */
  detectConflict(draftId: string, opts?: DraftOperationOptions): Promise<ConflictReport>
  /** Authorized review state across the whole draft, ordered by table and stable row identity. */
  inspect(draftId: string, opts?: DraftOperationOptions): Promise<DraftInspectionRow[]>
  /** Read-only peek at a draft's current command log (post-compaction). */
  getLog(draftId: string, opts?: DraftOperationOptions): Promise<DraftCommand[]>
}

/**
 * Hook the app injects at publish to bind late-bound operands in the command log
 * immediately before commit. Receives the ordered log, returns the bound log.
 * The ONLY app-specific step inside an otherwise generic publish. Identity by
 * default (no late binding).
 */
export type ResolveHook = (log: Command[]) => Command[] | Promise<Command[]>

/**
 * A draft command carries an optional `compactionKey` so the log can collapse a
 * run of edits to the SAME logical target into a net effect. Two commands with
 * the same non-undefined `compactionKey` are "the same cell's history"; the
 * later supersedes the earlier UNLESS it is a delete that cancels a create.
 *
 * The lifecycle treats the key as OPAQUE (it never parses it) — the app mints it
 * (e.g. `${path}:${args.id}`). Commands with no key never compact (kept as-is,
 * order preserved). This keeps compaction generic: net-effect collapse without
 * any artifact-type knowledge.
 */
export interface DraftCommand extends Command {
  /** Opaque per-target key; same key ⇒ same logical cell history. */
  compactionKey?: string
  /** Marks a create (an insert). A delete with the same key as a create cancels both. */
  kind?: 'create' | 'update' | 'delete'
}

/**
 * Compact the log to net effect, per `compactionKey`. The collapse is
 * deliberately CONSERVATIVE — it never fuses commands of different `kind`,
 * because the lifecycle is generic: it cannot merge an `addTodo` and a
 * `renameTodo` into one command without artifact knowledge. Per key:
 *
 *   - **create + delete** (delete after a live create) → BOTH dropped: the row
 *     never existed canonically, so neither should publish.
 *   - **redundant updates** (a run of `kind:'update'`) → only the LAST survives
 *     (a SQL `UPDATE` is idempotent on the final value).
 *   - **create + later update(s)** → the create is KEPT (so publish inserts the
 *     row) AND the last update is kept (so publish applies the final edit), in
 *     order. The create is NOT replaced by the update — replacing it would make
 *     publish `UPDATE` a row that does not exist in canonical yet, silently
 *     dropping a created-then-edited item.
 *   - **delete of a canonical row** (no prior create) → kept.
 *   - **delete of a canonical row + a later create on the same key** (a REPLACE)
 *     → BOTH kept, in order. The canonical row must be removed before the new
 *     one is inserted; dropping either half publishes a duplicate-key insert or
 *     silently keeps the stale row. This differs from create + delete + create,
 *     where the leading create is draft-local and nothing canonical exists to
 *     remove, so only the final create survives.
 *
 * Commands with no `compactionKey`, or no `kind`, are never compacted and keep
 * their position. Surviving commands keep their original relative ORDER (publish
 * replays in order; the client-id invariant — a create precedes its referrer —
 * rides on that).
 */
export function compactLog(log: DraftCommand[]): DraftCommand[] {
  // For each key, decide which command POSITIONS (indices) survive. Tracking
  // indices — not object identity — makes the emit pass robust to the same
  // command object reference appearing multiple times in `log`: each surviving
  // role resolves to exactly one position, so no duplicate is emitted.
  const survivingCreate = new Map<string, number>()
  const lastUpdate = new Map<string, number>()
  // Only ever set in the else-branch below — i.e. when the key had NO live
  // draft-local create at that point. So an entry here means, by construction,
  // "a delete that targets canonical state", and it must survive independently
  // of anything the draft does to the key afterwards. That set-condition IS the
  // lineage tracking; no separate draft-local-create flag is needed.
  const survivingDelete = new Map<string, number>()

  for (let i = 0; i < log.length; i++) {
    const cmd = log[i]
    const key = cmd.compactionKey
    if (key === undefined || cmd.kind === undefined) continue
    if (cmd.kind === 'create') {
      // (Re)open the key: clear stale updates, which the create supersedes. A
      // surviving canonical delete is deliberately LEFT IN PLACE — delete-then-
      // create is a replace, and publish must run both, in order.
      survivingCreate.set(key, i)
      lastUpdate.delete(key)
    } else if (cmd.kind === 'update') {
      lastUpdate.set(key, i)
    } else {
      // delete
      if (survivingCreate.has(key)) {
        // Cancels a live DRAFT-LOCAL create — that row never existed canonically,
        // so its create and updates drop. An earlier canonical delete on the same
        // key is untouched: the canonical row still has to go.
        survivingCreate.delete(key)
        lastUpdate.delete(key)
      } else {
        // Delete of a canonical row: it wins, and supersedes any prior updates.
        lastUpdate.delete(key)
        survivingDelete.set(key, i)
      }
    }
  }

  // A position survives iff it is one of the kept positions for its key.
  const survivingIndices = new Set<number>()
  for (const m of [survivingCreate, lastUpdate, survivingDelete]) {
    for (const idx of m.values()) survivingIndices.add(idx)
  }

  // Emit in original order. Keyless / kindless commands always pass through;
  // keyed-and-kinded ones only at a surviving position.
  const out: DraftCommand[] = []
  for (let i = 0; i < log.length; i++) {
    const cmd = log[i]
    if (cmd.compactionKey === undefined || cmd.kind === undefined) {
      out.push(cmd)
      continue
    }
    if (survivingIndices.has(i)) out.push(cmd)
  }
  return out
}

let draftCounter = 0
function mintDraftId(): string {
  // Monotonic + random suffix: unique within a process without a uuid dep.
  draftCounter += 1
  return `draft_${Date.now().toString(36)}_${draftCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Deep-copy a command for the publish log so a later mutation of the caller's
 * batch/args cannot change what `publish` replays. `args` is opaque JSON-shaped
 * data (it crosses the RPC boundary), so `structuredClone` is the correct,
 * reference-breaking copy; the lifecycle never interprets `args`.
 */
function snapshotCommand(cmd: DraftCommand): DraftCommand {
  return {
    ...cmd,
    args: cmd.args === undefined ? cmd.args : structuredClone(cmd.args),
  }
}

/** Schema-qualified table key (`schema.table` or bare `table`) — disambiguates
 * same-named tables in different schemas in the touched-tables map. */
function qualifiedTableKey(table: AnyTable): string {
  const name = getTableName(table)
  const schema = getTableConfig(table).schema
  return schema ? `${schema}.${name}` : name
}

function describeTouchedTables(
  touchedTables: Map<string, AnyTable>,
  draftWrites: Set<string>,
  draftId: string,
  tenantId: unknown | undefined,
): StoredTouchedTable[] {
  return [...touchedTables.values()].flatMap((table) => {
    const tableName = getTableName(table)
    const config = getTableConfig(table)
    const qualifiedName = qualifiedTableKey(table)
    const draftTag = draftInvalidationIdentity(table, draftId, tenantId)
    if (!draftWrites.has(draftTag)) return []
    const columns = getTableColumns(table) as Record<string, { name: string; getSQLType(): string }>
    const pkColumn = resolvePkColumnName(table, config)
    const pk = Object.values(columns).find((column) => column.name === pkColumn)
    if (!pk) throw new Error(`draft lifecycle: cannot resolve primary key for "${qualifiedName}"`)
    const capabilities = tryGetTableCapabilities(table)
    const revision = capabilities?.revisionProperty
      ? columns[capabilities.revisionProperty]
      : undefined
    const tenant = capabilities?.tenancy ? columns[capabilities.tenancy.property] : undefined
    return [
      {
        schema: config.schema,
        table: tableName,
        pkColumn,
        pkType: normalizeSqlType(pk.getSQLType()),
        tenantColumn: tenant?.name,
        tenantType: tenant ? normalizeSqlType(tenant.getSQLType()) : undefined,
        revisionColumn: revision?.name,
        invalidationTag: draftTag,
      },
    ]
  })
}

function normalizeSqlType(type: string): string {
  const normalized = type.toLowerCase()
  if (normalized === 'serial') return 'integer'
  if (normalized === 'bigserial') return 'bigint'
  if (normalized === 'smallserial') return 'smallint'
  return normalized
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function identityCast(type: string): string {
  const normalized = normalizeSqlType(type)
  if (!['integer', 'bigint', 'smallint', 'text', 'uuid', 'varchar'].includes(normalized)) {
    throw new Error(`draft lifecycle: unsupported persisted identity type "${type}"`)
  }
  return normalized
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
  const { versionProbe, resolveOwner, authorizeDraft, validateGraph } = opts
  let storageInitialization: Promise<void> | undefined

  function storageReady(): Promise<void> {
    if (!storageInitialization) {
      const attempt = ensureDraftStorage(app.createTracked().raw)
      storageInitialization = attempt
      void attempt.catch(() => {
        if (storageInitialization === attempt) storageInitialization = undefined
      })
    }
    return storageInitialization
  }

  async function ownerKey(context: Record<string, unknown>): Promise<unknown> {
    return resolveOwner ? resolveOwner(context) : defaultOwnerKey(context)
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
    const scoped = await app.scopeTracked(tracked, context)
    if (!sameJsonValue(scoped.tenantId, draft.tenantId)) {
      throw notFound(draft.draftId)
    }
    const currentOwner = await ownerKey(context)
    if (sameJsonValue(currentOwner, draft.ownerKey)) return scoped
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
      await storageReady()
      const context = openOpts.context ?? {}
      const scoped = await app.scopeTracked(app.createTracked(), context)
      const resolvedOwnerKey = await ownerKey(context)
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
      const outer = app.createTracked()
      let draftWrites = new Set<string>()
      const results = await outer.transaction(async (tx) => {
        const stored = await requireStored(tx.raw, draftId, true)
        const scopedTx = await authorizeTracker(tx, stored, context, 'append')
        const existingLog = await readStoredCommands(tx.raw, draftId)
        const touchedTables = new Map<string, AnyTable>()
        const draftDb = recordTouchedTables(scopedTx.withDraft(draftId), touchedTables)
        const results: CommandResult[] = []
        for (const snapshot of commands) {
          const definition = app.functions.get(snapshot.path)
          if (definition?.type === 'action') {
            throw new Error(`Draft command ${snapshot.path} cannot reference an action`)
          }
          const value = await app.runHandler(snapshot.path, snapshot.args, draftDb, context)
          results.push({ id: snapshot.id, value })
        }

        const compactedLog = compactLog([...existingLog, ...commands])
        await replaceStoredCommands(tx.raw, draftId, compactedLog)
        await upsertStoredTouchedTables(
          tx.raw,
          draftId,
          describeTouchedTables(touchedTables, draftDb.tablesWritten, draftId, scopedTx.tenantId),
        )
        await advanceStoredDraftRevision(tx.raw, draftId, stored.logRevision)
        draftWrites = new Set(draftDb.tablesWritten)
        return results
      })
      if (draftWrites.size > 0) app.emit(draftWrites)
      return results
    },

    async publish(draftId, resolve, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      const snapshot = await requireStored(app.createTracked().raw, draftId)
      await authorizeTracker(app.createTracked(), snapshot, context, 'publish')
      const snapshotLog = await readStoredCommands(app.createTracked().raw, draftId)
      const boundLog = resolve ? await resolve([...snapshotLog]) : [...snapshotLog]

      let draftWrites = new Set<string>()
      const result = await app.createTracked().transaction(async (tx) => {
        const current = await requireStored(tx.raw, draftId, true)
        const scopedTx = await authorizeTracker(tx, current, context, 'publish')
        if (current.logRevision !== snapshot.logRevision) {
          throw new Error(`draft lifecycle: draft "${draftId}" changed during publish; retry`)
        }
        const touched = await readStoredTouchedTables(tx.raw, draftId)
        await assertDraftRowsUnchanged(tx.raw, draftId, touched)
        await validateGraph?.({
          phase: 'effective',
          draftId,
          db: scopedTx.withDraft(draftId),
          context,
        })
        const committed = (await applyCommands(app, boundLog, {
          mode: 'commit',
          context,
          tx: scopedTx,
        })) as CommitResult
        await validateGraph?.({ phase: 'published', draftId, db: scopedTx, context })
        await clearDerivedChanges(tx.raw, draftId)
        await deleteStoredDraft(tx.raw, draftId)
        draftWrites = new Set(
          touched.flatMap((table) => (table.invalidationTag ? [table.invalidationTag] : [])),
        )
        return committed
      })

      const tags = new Set([...result.tablesWritten, ...draftWrites])
      if (tags.size > 0) app.emit(tags)
      return result
    },

    async discard(draftId, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      let draftWrites = new Set<string>()
      await app.createTracked().transaction(async (tx) => {
        const stored = await requireStored(tx.raw, draftId, true)
        await authorizeTracker(tx, stored, context, 'discard')
        const touched = await readStoredTouchedTables(tx.raw, draftId)
        await clearDerivedChanges(tx.raw, draftId)
        await deleteStoredDraft(tx.raw, draftId)
        draftWrites = new Set(
          touched.flatMap((table) => (table.invalidationTag ? [table.invalidationTag] : [])),
        )
      })
      if (draftWrites.size > 0) app.emit(draftWrites)
    },

    async rebase(draftId, operationOpts = {}) {
      await storageReady()
      if (!versionProbe) {
        throw new Error('draft lifecycle: rebase requires a versionProbe')
      }
      const context = operationOpts.context ?? {}
      let emitted = new Set<string>()
      let report: ConflictReport = { staleBase: false, overlappingCells: [] }
      await app.createTracked().transaction(async (tx) => {
        const stored = await requireStored(tx.raw, draftId, true)
        const scopedTx = await authorizeTracker(tx, stored, context, 'rebase')
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
          await app.runHandler(command.path, command.args, draftDb, context)
        }
        const rebuiltTouched = describeTouchedTables(
          touchedTables,
          draftDb.tablesWritten,
          draftId,
          scopedTx.tenantId,
        )
        await upsertStoredTouchedTables(tx.raw, draftId, rebuiltTouched)
        await validateGraph?.({ phase: 'effective', draftId, db: draftDb, context })
        await replaceStoredDraftBase(tx.raw, draftId, currentVersion, stored.logRevision)
        emitted = new Set([
          ...previousTouched.flatMap((table) =>
            table.invalidationTag ? [table.invalidationTag] : [],
          ),
          ...draftDb.tablesWritten,
        ])
      })
      if (emitted.size > 0) app.emit(emitted)
      return report
    },

    async detectConflict(draftId, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      const stored = await requireStored(app.createTracked().raw, draftId)
      const scoped = await authorizeTracker(app.createTracked(), stored, context, 'detectConflict')
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
      const stored = await requireStored(app.createTracked().raw, draftId)
      const scoped = await authorizeTracker(app.createTracked(), stored, context, 'inspect')
      return inspectDraftRows(scoped.raw, draftId)
    },

    async getLog(draftId, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      const stored = await requireStored(app.createTracked().raw, draftId)
      const scoped = await authorizeTracker(app.createTracked(), stored, context, 'getLog')
      return readStoredCommands(scoped.raw, draftId)
    },
  }
}

/**
 * Wrap a draft handle so every `into(table)` / `from(table)` records the Drizzle
 * table OBJECT (keyed by SQL name) as a candidate. We capture reads too because
 * `from(t).where(...).delete()` routes through `from`; after execution,
 * `describeTouchedTables` keeps only candidates whose draft write tag actually
 * committed. Canonical-only reads therefore never become draft sweep targets.
 */
function recordTouchedTables(
  draftDb: DraftDrizzleTracker,
  touchedTables: Map<string, AnyTable>,
): DraftDrizzleTracker {
  const record = (table: AnyTable) => {
    // Key by SCHEMA-QUALIFIED name. A bare `getTableName` would collide
    // `app.accounts` with `audit.accounts` (same base name, different schema),
    // so the later record would drop the earlier table object — leaving one
    // derived state uncleaned + one set of cells invisible to conflict detection.
    touchedTables.set(qualifiedTableKey(table), table)
  }
  return {
    tablesRead: draftDb.tablesRead,
    tablesWritten: draftDb.tablesWritten,
    raw: draftDb.raw,
    from(table) {
      record(table)
      return draftDb.from(table)
    },
    into(table) {
      record(table)
      return draftDb.into(table)
    },
    // Delegate to the underlying draft handle's transaction, which throws the
    // named "drafts have no per-handler transaction" contract error.
    transaction: draftDb.transaction.bind(draftDb),
  }
}

async function assertDraftRowsUnchanged(
  raw: DrizzleTracker['raw'],
  draftId: string,
  touchedTables: StoredTouchedTable[],
): Promise<void> {
  const conflicts: DraftRowConflict[] = []
  for (const table of touchedTables) {
    const tableIdentity = table.schema ? `${table.schema}.${table.table}` : table.table
    const relation = table.schema
      ? `${quoteIdentifier(table.schema)}.${quoteIdentifier(table.table)}`
      : quoteIdentifier(table.table)
    const pk = quoteIdentifier(table.pkColumn)
    const pkValue = `(d.row_key #>> '{value}')::${identityCast(table.pkType)}`
    const tenantJoin =
      table.tenantColumn && table.tenantType
        ? ` AND c.${quoteIdentifier(table.tenantColumn)} = (d.tenant_key #>> '{value}')::${identityCast(table.tenantType)}`
        : ''

    await raw.execute(
      sql`${sql.raw(
        `SELECT c.${pk} FROM ${relation} c JOIN wystack_draft_row_changes d ` +
          `ON c.${pk} = ${pkValue}${tenantJoin} WHERE d.draft_id = `,
      )}${draftId}${sql.raw(' AND d.table_key = ')}${tableIdentity}${sql.raw(' FOR UPDATE OF c')}`,
    )

    const revisionConflict = table.revisionColumn
      ? ` OR (d.base_exists AND (c.${quoteIdentifier(table.revisionColumn)} IS NULL OR d.base_revision IS DISTINCT FROM to_jsonb(c.${quoteIdentifier(table.revisionColumn)})))`
      : ''
    const rows = normalizeRows(
      await raw.execute(
        sql`${sql.raw(
          `SELECT d.row_key, CASE ` +
            `WHEN NOT d.base_exists AND c.${pk} IS NOT NULL THEN 'created' ` +
            `WHEN d.base_exists AND c.${pk} IS NULL THEN 'deleted' ` +
            `ELSE 'revision' END AS reason ` +
            `FROM wystack_draft_row_changes d LEFT JOIN ${relation} c ` +
            `ON c.${pk} = ${pkValue}${tenantJoin} WHERE d.draft_id = `,
        )}${draftId}${sql.raw(' AND d.table_key = ')}${tableIdentity}${sql.raw(
          ` AND ((NOT d.base_exists AND c.${pk} IS NOT NULL) ` +
            `OR (d.base_exists AND c.${pk} IS NULL)${revisionConflict})`,
        )}`,
      ),
    )
    for (const row of rows) {
      const key = decodeJsonColumn(row['row_key']) as { value?: unknown }
      conflicts.push({
        table: tableIdentity,
        id: key.value,
        reason: String(row['reason']) as DraftRowConflict['reason'],
      })
    }
  }
  if (conflicts.length > 0) throw new DraftConflictError(draftId, conflicts)
}

/**
 * Read the typed row keys this draft wrote into the central relation,
 * returning them as `(table, id)` cells. `draftId` is a BOUND parameter (guard
 * the sink); table/PK names are introspected identifiers. Tombstoned rows count
 * as touched cells — a draft delete still conflicts with a canonical write.
 */
async function enumerateTouchedCells(
  raw: DrizzleTracker['raw'],
  draftId: string,
  touchedTables: StoredTouchedTable[],
): Promise<Cell[]> {
  const cells: Cell[] = []
  for (const table of touchedTables) {
    const tableIdentity = table.schema ? `${table.schema}.${table.table}` : table.table
    const rows = normalizeRows(
      await raw.execute(sql`
        SELECT row_key
        FROM wystack_draft_row_changes
        WHERE draft_id = ${draftId} AND table_key = ${tableIdentity}
        ORDER BY tenant_key_text, row_key_text
      `),
    )
    for (const row of rows) {
      const encoded = decodeJsonColumn(row['row_key']) as { value?: unknown }
      cells.push({ table: tableIdentity, id: encoded?.value })
    }
  }
  return cells
}

async function inspectDraftRows(
  raw: DrizzleTracker['raw'],
  draftId: string,
): Promise<DraftInspectionRow[]> {
  const rows = normalizeRows(
    await raw.execute(sql`
      SELECT draft_id, table_key, tenant_key, row_key, operation,
             base_exists, base_revision, fields
      FROM wystack_draft_row_changes
      WHERE draft_id = ${draftId}
      ORDER BY table_key, tenant_key_text, row_key_text
    `),
  )
  return rows.map((row) => ({
    draftId: String(row['draft_id']),
    table: String(row['table_key']),
    tenantKey: decodeJsonColumn(row['tenant_key']),
    rowKey: decodeJsonColumn(row['row_key']),
    operation: String(row['operation']) as DraftInspectionRow['operation'],
    baseExists: Boolean(row['base_exists']),
    baseRevision: decodeJsonColumn(row['base_revision']),
    fields: decodeJsonColumn(row['fields']) as DraftInspectionRow['fields'],
  }))
}

/**
 * Delete a draft's central derived rows in one indexed sweep. `draftId` bound.
 *
 * Accepts a `raw` Drizzle db handle directly (rather than a `WyStackApp`) so
 * the caller can pass a tx-bound handle and share a commit boundary. When
 * called from `publish`, `raw` is `tx.raw` inside the outer transaction —
 * sweep and replay commit atomically. When called from `discard`, `raw` is
 * `tx.raw` inside a transaction scoped to the sweep alone, keeping the derived
 * delete and lifecycle metadata changes inside the same commit boundary.
 */
async function clearDerivedChanges(
  // oxlint-disable-next-line typescript/no-explicit-any -- DrizzleDb is `any` in @wystack/db
  raw: any,
  draftId: string,
): Promise<void> {
  await raw.execute(sql`DELETE FROM wystack_draft_row_changes WHERE draft_id = ${draftId}`)
}

function decodeJsonColumn(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function normalizeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}
