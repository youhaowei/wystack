// @wystack/server — generic draft lifecycle (the third leg of the draft model)
//
// The draft system has three legs:
//   1. Read overlay  — `withDraft(draftId)` coalesce (canonical ⊕ delta). READ.
//   2. Write storage — `<table>__draft` shadow (sparse upsert + tombstone),
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
// The load-bearing correction (from the convergence spike): PUBLISH = REPLAY THE
// ORDERED COMMAND LOG via `applyCommands(app, log, {commit})`, NOT "apply a
// row-delta onto canonical." The command log is the publish unit because it
// preserves INTENT GROUPING (e.g. an `add_to_dashboard` command merges into the
// dashboard node — a row-delta cannot reconstruct that). The `<table>__draft`
// delta tables are the READ overlay; the command log is the PUBLISH source. The
// two are different artifacts with different jobs.
//
// ATOMIC PUBLISH: `publish` adopts the `applyCommands` outer-tx seam
// to wrap command-log replay + shadow-sweep in ONE transaction.
// This eliminates the crash window that previously existed between "canonical
// committed" and "shadow cleared" — if either step fails, both roll back. The
// draft stays live and publish is retryable. This is the wystack-internal adoption
// of the primitive; an application's draft controller adopts separately
// (the durable-log delete is the analogous bookkeeping step there).

import { resolvePkColumnName, type DraftDrizzleTracker, type DrizzleTracker } from '@wystack/db'
import { isPrincipal } from '@wystack/identity'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getTableName, sql } from 'drizzle-orm'
import {
  applyCommands,
  type Command,
  type CommandResult,
  type CommitResult,
} from './apply-commands'
import type { WyStackApp } from './create'
import {
  advanceStoredDraftRevision,
  deleteStoredDraft,
  ensureDraftStorage,
  insertStoredDraft,
  readStoredCommands,
  readStoredDraft,
  readStoredTouchedTables,
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

export interface OpenOptions {
  /** Current request context used to bind tenant and owner custody. Never persisted. */
  context?: Record<string, unknown>
}

export interface DraftOperationOptions {
  /** Current request context. Authorization is re-evaluated on every operation. */
  context?: Record<string, unknown>
}

export interface DraftLifecycleOptions {
  versionProbe?: VersionProbe
  /** Resolve the stable owner/custodian key. Defaults to the Principal's kind and stable ID. */
  resolveOwner?: (context: Record<string, unknown>) => unknown | Promise<unknown>
  /** Override owner-only access for explicit collaboration/product policy. Tenant scope still applies. */
  authorizeDraft?: (request: DraftAuthorizationRequest) => boolean | Promise<boolean>
}

export interface DraftAuthorizationRequest {
  action: 'append' | 'publish' | 'discard' | 'detectConflict' | 'getLog'
  draft: {
    draftId: string
    tenantId: unknown | undefined
    ownerKey: unknown | undefined
  }
  context: Record<string, unknown>
}

export interface DraftLifecycle {
  /** Open a draft over a base snapshot. Returns the new draft id. */
  open(baseVersion: Version, opts?: OpenOptions): Promise<string>
  /**
   * Apply a batch of commands INSIDE the draft: routes each command's writes
   * into the `<table>__draft` overlay (via `withDraft`'s write path) and appends
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
   * draft's shadow, command log, and metadata are cleared on success.
   *
   * Invalidation is the LIFECYCLE's job, not the host's: publish emits the
   * canonical tags from the replay plus the `<table>__draft` tags for the sweep
   * (untracked, so `applyCommands` cannot report them), once the transaction has
   * durably committed. `append` and `discard` emit too — every entry point that
   * writes announces its own writes, so no consumer can forget to and leave
   * subscriptions silently stale. `tablesWritten` is still returned for hosts
   * that want the set for their own bookkeeping.
   *
   * The resolve hook runs outside the transaction. Publish then row-locks the
   * draft and compares its persisted log revision; an append during resolution
   * advances that revision and makes this attempt fail for a safe retry. Replay,
   * shadow sweep, and metadata/log deletion share the locked transaction.
   */
  publish(
    draftId: string,
    resolve?: ResolveHook,
    opts?: DraftOperationOptions,
  ): Promise<CommitResult>
  /**
   * Drop the draft: row-lock its metadata, clear every persisted touched-table
   * shadow, and delete its command log and metadata in one transaction.
   */
  discard(draftId: string, opts?: DraftOperationOptions): Promise<void>
  /**
   * Detect whether canonical moved under the draft. Returns the two generic
   * signals; makes NO policy decision. Reads the draft's touched cells straight
   * from the `<table>__draft` shadow (the `(draftId, id)` keys), then asks the
   * app's `VersionProbe` which canonical also wrote.
   */
  detectConflict(draftId: string, opts?: DraftOperationOptions): Promise<ConflictReport>
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
  shadowWrites: Set<string>,
): StoredTouchedTable[] {
  return [...touchedTables.values()].flatMap((table) => {
    const tableName = getTableName(table)
    const config = getTableConfig(table)
    const qualifiedName = qualifiedTableKey(table)
    const globalTag = `${qualifiedName}__draft`
    const tenantMarker = `:${qualifiedName}__draft:draft:`
    const shadowTag = [...shadowWrites].find(
      (tag) => tag === globalTag || tag.includes(tenantMarker),
    )
    if (!shadowTag) return []
    return [
      {
        schema: config.schema,
        table: tableName,
        pkColumn: resolvePkColumnName(table, config),
        shadowTag,
      },
    ]
  })
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
 *               connection backs both the shadow writes and the publish replay.
 * @param opts.versionProbe  the ONLY app injection for conflict DETECTION; speaks
 *               `(table, id, version)` only. Omit it and `detectConflict` reports
 *               a no-conflict report (the app opted out of detection).
 */
export function createDraftLifecycle(
  app: WyStackApp,
  opts: DraftLifecycleOptions = {},
): DraftLifecycle {
  const { versionProbe, resolveOwner, authorizeDraft } = opts
  let storageInitialization: Promise<void> | undefined

  function storageReady(): Promise<void> {
    storageInitialization ??= ensureDraftStorage(app.createTracked().raw)
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

  async function authorizeTracker(
    tracked: DrizzleTracker,
    draft: StoredDraft,
    context: Record<string, unknown>,
    action: DraftAuthorizationRequest['action'],
  ): Promise<DrizzleTracker> {
    const scoped = await app.scopeTracked(tracked, context)
    if (!sameJsonValue(scoped.tenantId, draft.tenantId)) {
      throw new Error(`draft lifecycle: access denied for draft "${draft.draftId}"`)
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
    throw new Error(`draft lifecycle: access denied for draft "${draft.draftId}"`)
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
      let shadowWrites = new Set<string>()
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
          describeTouchedTables(touchedTables, draftDb.tablesWritten),
        )
        await advanceStoredDraftRevision(tx.raw, draftId, stored.logRevision)
        shadowWrites = new Set(draftDb.tablesWritten)
        return results
      })
      if (shadowWrites.size > 0) app.emit(shadowWrites)
      return results
    },

    async publish(draftId, resolve, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      const snapshot = await requireStored(app.createTracked().raw, draftId)
      await authorizeTracker(app.createTracked(), snapshot, context, 'publish')
      const snapshotLog = await readStoredCommands(app.createTracked().raw, draftId)
      const boundLog = resolve ? await resolve([...snapshotLog]) : [...snapshotLog]

      let shadowWrites = new Set<string>()
      const result = await app.createTracked().transaction(async (tx) => {
        const current = await requireStored(tx.raw, draftId, true)
        const scopedTx = await authorizeTracker(tx, current, context, 'publish')
        if (current.logRevision !== snapshot.logRevision) {
          throw new Error(`draft lifecycle: draft "${draftId}" changed during publish; retry`)
        }
        const touched = await readStoredTouchedTables(tx.raw, draftId)
        const committed = (await applyCommands(app, boundLog, {
          mode: 'commit',
          context,
          tx: scopedTx,
        })) as CommitResult
        await clearShadow(tx.raw, draftId, touched)
        await deleteStoredDraft(tx.raw, draftId)
        shadowWrites = new Set(
          touched.flatMap((table) => (table.shadowTag ? [table.shadowTag] : [])),
        )
        return committed
      })

      const tags = new Set([...result.tablesWritten, ...shadowWrites])
      if (tags.size > 0) app.emit(tags)
      return result
    },

    async discard(draftId, operationOpts = {}) {
      await storageReady()
      const context = operationOpts.context ?? {}
      let shadowWrites = new Set<string>()
      await app.createTracked().transaction(async (tx) => {
        const stored = await requireStored(tx.raw, draftId, true)
        await authorizeTracker(tx, stored, context, 'discard')
        const touched = await readStoredTouchedTables(tx.raw, draftId)
        await clearShadow(tx.raw, draftId, touched)
        await deleteStoredDraft(tx.raw, draftId)
        shadowWrites = new Set(
          touched.flatMap((table) => (table.shadowTag ? [table.shadowTag] : [])),
        )
      })
      if (shadowWrites.size > 0) app.emit(shadowWrites)
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

      // Fine signal: enumerate THIS draft's touched cells from the shadow tables
      // (the `(draft_id, id)` keys), then ask the probe which canonical also
      // wrote at/after base. Reading the shadow keeps detection artifact-blind.
      const touched = await readStoredTouchedTables(scoped.raw, draftId)
      const touchedCells = await enumerateTouchedCells(scoped.raw, draftId, touched)
      const overlappingCells =
        touchedCells.length > 0
          ? await versionProbe.cellsWrittenSince(stored.baseVersion, touchedCells)
          : []

      return { staleBase, overlappingCells }
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
 * committed. Canonical-only reads therefore never become shadow sweep targets.
 */
function recordTouchedTables(
  draftDb: DraftDrizzleTracker,
  touchedTables: Map<string, AnyTable>,
): DraftDrizzleTracker {
  const record = (table: AnyTable) => {
    // Key by SCHEMA-QUALIFIED name. A bare `getTableName` would collide
    // `app.accounts` with `audit.accounts` (same base name, different schema),
    // so the later record would drop the earlier table object — leaving one
    // shadow uncleaned + one set of cells invisible to conflict detection.
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

/**
 * Read the `(id)` keys this draft wrote into each touched `<table>__draft`,
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
    const draftRel = qualifiedDraftRelation(table)
    const prefix = sql.raw(
      `SELECT ${quoteIdentifier(table.pkColumn)} AS id FROM ${draftRel} WHERE "draft_id" = `,
    )
    const rows = normalizeRows(await raw.execute(sql`${prefix}${draftId}`))
    const tableIdentity = table.schema ? `${table.schema}.${table.table}` : table.table
    for (const r of rows) cells.push({ table: tableIdentity, id: (r as { id: unknown }).id })
  }
  return cells
}

/**
 * Delete a draft's shadow rows across every table it touched. `draftId` bound.
 *
 * Accepts a `raw` Drizzle db handle directly (rather than a `WyStackApp`) so
 * the caller can pass a tx-bound handle and share a commit boundary. When
 * called from `publish`, `raw` is `tx.raw` inside the outer transaction —
 * sweep and replay commit atomically. When called from `discard`, `raw` is
 * `tx.raw` inside a transaction scoped to the sweep alone (no replay to share
 * it with) — still required because this function issues one DELETE per
 * touched table, and without a shared commit boundary a failure partway
 * through would leave earlier tables' deletes durably committed with no
 * invalidation ever emitted for them.
 */
async function clearShadow(
  // oxlint-disable-next-line typescript/no-explicit-any -- DrizzleDb is `any` in @wystack/db
  raw: any,
  draftId: string,
  touchedTables: StoredTouchedTable[],
): Promise<void> {
  for (const table of touchedTables) {
    const draftRel = qualifiedDraftRelation(table)
    const prefix = sql.raw(`DELETE FROM ${draftRel} WHERE "draft_id" = `)
    await raw.execute(sql`${prefix}${draftId}`)
  }
}

function qualifiedDraftRelation(table: StoredTouchedTable): string {
  const relation = quoteIdentifier(`${table.table}__draft`)
  return table.schema ? `${quoteIdentifier(table.schema)}.${relation}` : relation
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function normalizeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}
