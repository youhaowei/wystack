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
// This layer is GENERIC: it knows NOTHING about DashFrame artifacts. It speaks
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

import { resolvePkColumnName, type DraftTrackedDb } from '@wystack/db'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getTableName, sql } from 'drizzle-orm'
import {
  applyCommands,
  type Command,
  type CommandResult,
  type CommitResult,
} from './apply-commands'
import type { WyStackApp } from './create'

// oxlint-disable-next-line typescript/no-explicit-any -- polymorphic Drizzle table, mirrors tracked-db.ts
type AnyTable = any

/**
 * A `(table, id)` pair — one CELL the draft touched or canonical wrote. The
 * lifecycle's conflict detection speaks only this and an opaque `Version`; it
 * carries ZERO artifact-type knowledge. `id` is the row's primary-key value,
 * `table` its SQL table name.
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

/** Per-draft registry entry. In-memory; a draft is ephemeral until published. */
interface DraftEntry {
  baseVersion: Version
  /**
   * The ordered command log — the PUBLISH unit. Replayed (never read) at publish
   * via `applyCommands`. Compacted on append (see `compactLog`) so a long
   * add→tweak→delete chain collapses to its net effect.
   */
  log: Command[]
  /**
   * The Drizzle table OBJECTS this draft wrote into the shadow, keyed by SQL
   * table name. Detection + teardown need the table object (schema + PK
   * introspection), not just the name — so we capture the object as handlers
   * write, via a table-recording wrapper around the draft handle.
   */
  touchedTables: Map<string, AnyTable>
  /** Per-batch context threaded to publish's replay (auth/tenant). */
  context: Record<string, unknown>
}

export interface OpenOptions {
  /** Per-draft context (auth/tenant) forwarded to publish's command replay. */
  context?: Record<string, unknown>
}

export interface DraftLifecycle {
  /** Open a draft over a base snapshot. Returns the new draft id. */
  open(baseVersion: Version, opts?: OpenOptions): string
  /**
   * Apply a batch of commands INSIDE the draft: routes each command's writes
   * into the `<table>__draft` overlay (via `withDraft`'s write path) and appends
   * them to the command log. Reads inside the handler see `canonical ⊕ draft`.
   * Returns the per-command results (same shape as `applyCommands`).
   *
   * NOT atomic across the batch the way `publish` is — append is incremental
   * draft authoring; the atomic boundary is `publish`.
   */
  append(draftId: string, batch: Command[]): Promise<CommandResult[]>
  /**
   * PUBLISH = replay the ordered command log onto canonical via
   * `applyCommands(app, log, {commit})`, calling `resolve(log)` IMMEDIATELY
   * before the commit (the ONLY app injection inside publish — it binds
   * late-bound operands). Atomic via `applyCommands`'s YW-119 tracked tx; the
   * returned `tablesWritten` is what the HOST flushes to invalidation (the
   * lifecycle does not wire invalidation itself — same posture as
   * `applyCommands`). The draft's shadow + registry entry are cleared on success.
   */
  publish(draftId: string, resolve?: ResolveHook): Promise<CommitResult>
  /** Drop the draft: clear its shadow rows and forget its registry entry. */
  discard(draftId: string): Promise<void>
  /**
   * Detect whether canonical moved under the draft. Returns the two generic
   * signals; makes NO policy decision. Reads the draft's touched cells straight
   * from the `<table>__draft` shadow (the `(draftId, id)` keys), then asks the
   * app's `VersionProbe` which canonical also wrote.
   */
  detectConflict(draftId: string): Promise<ConflictReport>
  /** Read-only peek at a draft's current command log (post-compaction). */
  getLog(draftId: string): Command[]
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
 * Compact the log: collapse runs that share a `compactionKey` to net effect.
 *   - create then delete (same key)      → both removed (never existed)
 *   - create/update then update (same key) → the LATER kept, earlier dropped
 *   - delete then anything (same key)      → later kept
 * Commands with no `compactionKey` are never compacted and keep their order.
 *
 * Ordering is preserved by anchoring each key's surviving command at the
 * position of the key's LAST occurrence (its net effect happens "last").
 */
export function compactLog(log: DraftCommand[]): DraftCommand[] {
  // Last-write-wins per key, with create+delete cancellation.
  const lastByKey = new Map<string, DraftCommand>()
  const createdKeys = new Set<string>()
  for (const cmd of log) {
    if (cmd.compactionKey === undefined) continue
    if (cmd.kind === 'create') createdKeys.add(cmd.compactionKey)
    if (cmd.kind === 'delete' && createdKeys.has(cmd.compactionKey)) {
      // A delete cancelling a create within this draft: the row never existed
      // canonically, so neither command should publish. Drop the whole history.
      lastByKey.delete(cmd.compactionKey)
      createdKeys.delete(cmd.compactionKey)
      // Mark as cancelled so we also skip it in the emit pass below.
      lastByKey.set(cmd.compactionKey, CANCELLED)
      continue
    }
    lastByKey.set(cmd.compactionKey, cmd)
  }

  const emitted = new Set<string>()
  const out: DraftCommand[] = []
  for (const cmd of log) {
    if (cmd.compactionKey === undefined) {
      out.push(cmd)
      continue
    }
    if (emitted.has(cmd.compactionKey)) continue
    const survivor = lastByKey.get(cmd.compactionKey)
    emitted.add(cmd.compactionKey)
    if (survivor === undefined || survivor === CANCELLED) continue
    out.push(survivor)
  }
  return out
}

/** Sentinel marking a compaction key whose create was cancelled by a delete. */
const CANCELLED = Symbol('cancelled') as unknown as DraftCommand

let draftCounter = 0
function mintDraftId(): string {
  // Monotonic + random suffix: unique within a process without a uuid dep.
  draftCounter += 1
  return `draft_${Date.now().toString(36)}_${draftCounter.toString(36)}_${Math.random().toString(36).slice(2, 8)}`
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
  opts: { versionProbe?: VersionProbe } = {},
): DraftLifecycle {
  const drafts = new Map<string, DraftEntry>()
  const { versionProbe } = opts

  function require(draftId: string): DraftEntry {
    const entry = drafts.get(draftId)
    if (!entry) throw new Error(`draft lifecycle: unknown draft "${draftId}"`)
    return entry
  }

  return {
    open(baseVersion, openOpts = {}) {
      const draftId = mintDraftId()
      drafts.set(draftId, {
        baseVersion,
        log: [],
        touchedTables: new Map(),
        context: openOpts.context ?? {},
      })
      return draftId
    },

    async append(draftId, batch) {
      const entry = require(draftId)
      // Route writes through the draft handle so `ctx.db.into/update/delete`
      // lands in the `<table>__draft` overlay. The recording wrapper captures
      // the Drizzle table OBJECTS written, keyed by SQL name, so detection +
      // teardown can introspect schema/PK without a global schema registry.
      const draftDb: DraftTrackedDb = recordTouchedTables(
        app.createTracked().withDraft(draftId),
        entry.touchedTables,
      )
      const results: CommandResult[] = []
      for (const cmd of batch) {
        const value = await app.runHandler(cmd.path, cmd.args, draftDb, entry.context)
        results.push({ id: cmd.id, value })
        entry.log.push(cmd)
      }
      // Compact the accumulated log to net effect (no-op for keyless commands).
      entry.log = compactLog(entry.log as DraftCommand[])
      return results
    },

    async publish(draftId, resolve) {
      const entry = require(draftId)
      // Bind late-bound operands immediately before commit — the ONLY app
      // injection inside publish. Identity if no hook supplied.
      const boundLog = resolve ? await resolve([...entry.log]) : [...entry.log]
      // PUBLISH = replay the ordered command log onto canonical, atomically.
      const result = (await applyCommands(app, boundLog, {
        mode: 'commit',
        context: entry.context,
      })) as CommitResult
      // Published — tear down the draft's shadow + registry. The host flushes
      // `result.tablesWritten` to invalidation (lifecycle does not, by design).
      await clearShadow(app, draftId, [...entry.touchedTables.values()])
      drafts.delete(draftId)
      return result
    },

    async discard(draftId) {
      const entry = require(draftId)
      await clearShadow(app, draftId, [...entry.touchedTables.values()])
      drafts.delete(draftId)
    },

    async detectConflict(draftId) {
      const entry = require(draftId)
      if (!versionProbe) {
        // No probe ⇒ detection opted out. Report no conflict (the app chose not
        // to track canonical versions).
        return { staleBase: false, overlappingCells: [] }
      }

      const current = await versionProbe.current()
      const staleBase = versionProbe.isNewerThan(current, entry.baseVersion)

      // Fine signal: enumerate THIS draft's touched cells from the shadow tables
      // (the `(draft_id, id)` keys), then ask the probe which canonical also
      // wrote at/after base. Reading the shadow keeps detection artifact-blind.
      const touchedCells = await enumerateTouchedCells(app, draftId, [
        ...entry.touchedTables.values(),
      ])
      const overlappingCells =
        touchedCells.length > 0
          ? await versionProbe.cellsWrittenSince(entry.baseVersion, touchedCells)
          : []

      return { staleBase, overlappingCells }
    },

    getLog(draftId) {
      return [...require(draftId).log]
    },
  }
}

/**
 * Wrap a draft handle so every `into(table)` / `from(table)` records the Drizzle
 * table OBJECT (keyed by SQL name) into `touchedTables`. We capture the object —
 * not just the name from `tablesWritten` — because detection + teardown need to
 * introspect each table's schema + PK, and there is no generic name→table
 * registry. Reads (`from`) are recorded too: a `from(t).where(eqPk).delete()`
 * routes through `from`, so a delete-only draft is still captured.
 */
function recordTouchedTables(
  draftDb: DraftTrackedDb,
  touchedTables: Map<string, AnyTable>,
): DraftTrackedDb {
  const record = (table: AnyTable) => {
    touchedTables.set(getTableName(table), table)
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
  }
}

/**
 * Read the `(id)` keys this draft wrote into each touched `<table>__draft`,
 * returning them as `(table, id)` cells. `draftId` is a BOUND parameter (guard
 * the sink); table/PK names are introspected identifiers. Tombstoned rows count
 * as touched cells — a draft delete still conflicts with a canonical write.
 */
async function enumerateTouchedCells(
  app: WyStackApp,
  draftId: string,
  touchedTables: AnyTable[],
): Promise<Cell[]> {
  const db = app.createTracked().raw
  const cells: Cell[] = []
  for (const drizzleTable of touchedTables) {
    const tableName = getTableName(drizzleTable)
    const config = getTableConfig(drizzleTable)
    const pkColName = resolvePkColumnName(drizzleTable, config)
    const schema = config.schema
    const draftRel = schema ? `"${schema}"."${tableName}__draft"` : `"${tableName}__draft"`
    const prefix = sql.raw(`SELECT "${pkColName}" AS id FROM ${draftRel} WHERE "draft_id" = `)
    const rows = normalizeRows(await db.execute(sql`${prefix}${draftId}`))
    for (const r of rows) cells.push({ table: tableName, id: (r as { id: unknown }).id })
  }
  return cells
}

/** Delete a draft's shadow rows across every table it touched. `draftId` bound. */
async function clearShadow(
  app: WyStackApp,
  draftId: string,
  touchedTables: AnyTable[],
): Promise<void> {
  const db = app.createTracked().raw
  for (const drizzleTable of touchedTables) {
    const tableName = getTableName(drizzleTable)
    const config = getTableConfig(drizzleTable)
    const schema = config.schema
    const draftRel = schema ? `"${schema}"."${tableName}__draft"` : `"${tableName}__draft"`
    const prefix = sql.raw(`DELETE FROM ${draftRel} WHERE "draft_id" = `)
    await db.execute(sql`${prefix}${draftId}`)
  }
}

function normalizeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}
