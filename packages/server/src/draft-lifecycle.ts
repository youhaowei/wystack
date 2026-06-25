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
//
// ATOMIC PUBLISH (YW-300): `publish` adopts the `applyCommands` outer-tx seam
// (added in YW-297) to wrap command-log replay + shadow-sweep in ONE transaction.
// This eliminates the crash window that previously existed between "canonical
// committed" and "shadow cleared" — if either step fails, both roll back. The
// draft stays live and publish is retryable. This is the wystack-internal adoption
// of the primitive; DashFrame's `DraftController.publishDraft` adopts separately
// (the durable-log delete is the analogous bookkeeping step there).

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
  log: DraftCommand[]
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
   * draft authoring; the atomic boundary is `publish`. On a mid-batch command
   * failure the throw propagates with the already-applied commands left in the
   * shadow + log — the conducting app owns recovery (re-append or `discard`).
   *
   * `batch` is `DraftCommand[]` so the optional `compactionKey`/`kind` fields
   * are discoverable at the call site — an app that wants net-effect log
   * compaction mints those; a plain `Command` (no key) is never compacted.
   */
  append(draftId: string, batch: DraftCommand[]): Promise<CommandResult[]>
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
  const survivingDelete = new Map<string, number>()

  for (let i = 0; i < log.length; i++) {
    const cmd = log[i]
    const key = cmd.compactionKey
    if (key === undefined || cmd.kind === undefined) continue
    if (cmd.kind === 'create') {
      // (Re)open the key: a create after a delete revives it; clear stale update/delete.
      survivingCreate.set(key, i)
      lastUpdate.delete(key)
      survivingDelete.delete(key)
    } else if (cmd.kind === 'update') {
      lastUpdate.set(key, i)
    } else {
      // delete
      if (survivingCreate.has(key)) {
        // Cancels a live create — the row never existed canonically. Drop all.
        survivingCreate.delete(key)
        lastUpdate.delete(key)
        survivingDelete.delete(key)
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
      // the Drizzle table OBJECTS written, keyed by schema-qualified name, so
      // detection + teardown can introspect schema/PK without a global schema registry.
      const draftDb: DraftTrackedDb = recordTouchedTables(
        app.createTracked().withDraft(draftId),
        entry.touchedTables,
      )
      const results: CommandResult[] = []
      for (const cmd of batch) {
        const value = await app.runHandler(cmd.path, cmd.args, draftDb, entry.context)
        results.push({ id: cmd.id, value })
        // Snapshot the command before storing it in the log. The log is the
        // publish unit (replayed verbatim later); storing the caller's object by
        // reference would let a post-append mutation of the batch or its `args`
        // silently change what `publish` replays — diverging the canonical
        // commit from the draft preview that was executed here.
        entry.log.push(snapshotCommand(cmd))
      }
      // Compact the accumulated log to net effect (no-op for keyless commands).
      entry.log = compactLog(entry.log)
      return results
    },

    async publish(draftId, resolve) {
      const entry = require(draftId)
      // Bind late-bound operands immediately before commit — the ONLY app
      // injection inside publish. Identity if no hook supplied.
      const boundLog = resolve ? await resolve([...entry.log]) : [...entry.log]
      const touched = [...entry.touchedTables.values()]

      // ATOMIC PUBLISH (YW-300): open ONE outer transaction so command-log
      // replay and shadow-sweep share a single commit boundary. A crash between
      // the two is no longer possible — if either step fails, both roll back,
      // and the in-memory registry entry stays intact so publish is retryable.
      //
      // Previously `clearShadow` ran AFTER `applyCommands` returned (two separate
      // transactions). A process death in that gap left the canonical commit durable
      // but shadow rows orphaned. While those orphans are inert for the in-memory
      // lifecycle (the map is gone on restart), the same latent window exists for
      // any durable consumer that wraps this lifecycle — closing it here at the
      // framework level is the Rule-of-Three extraction.
      const outer = app.createTracked()
      let capturedResult: CommitResult | undefined

      await outer.transaction(async (tx) => {
        // Replay the command log against the caller-supplied tx handle. The
        // outer-tx seam (applyCommands opts.tx, added in YW-297) routes all
        // command writes through this same handle — no inner transaction is
        // opened; the outer's commit boundary governs.
        capturedResult = (await applyCommands(app, boundLog, {
          mode: 'commit',
          context: entry.context,
          tx,
        })) as CommitResult
        // Shadow-sweep inside the SAME tx: shadow rows disappear atomically
        // with the canonical commit. On failure the outer tx rolls back both.
        // `tx.raw` is the native Drizzle handle bound to this transaction.
        await clearShadow(tx.raw, draftId, touched)
      })

      // Outer transaction committed. Remove the in-memory registry entry now
      // that the canonical write is durable and the shadow is swept. This is
      // post-commit — a crash here is harmless (the map is ephemeral and will
      // be empty on restart regardless). Deleting AFTER commit (not before)
      // preserves the entry for a retry if the outer tx rolls back.
      drafts.delete(draftId)
      // The host flushes result.tablesWritten to invalidation (the lifecycle
      // does not, by design — same posture as applyCommands).
      return capturedResult!
    },

    async discard(draftId) {
      const entry = require(draftId)
      // Discard has no replay to be atomic with — a fresh connection suffices.
      await clearShadow(app.createTracked().raw, draftId, [...entry.touchedTables.values()])
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

/**
 * Delete a draft's shadow rows across every table it touched. `draftId` bound.
 *
 * Accepts a `raw` Drizzle db handle directly (rather than a `WyStackApp`) so
 * the caller can pass a tx-bound handle and share the commit boundary with the
 * command replay. When called from `publish`, `raw` is `tx.raw` inside the outer
 * transaction — sweep and replay commit atomically (YW-300). For `discard`, a
 * fresh connection (`app.createTracked().raw`) is fine since discard has no
 * replay to be atomic with.
 */
async function clearShadow(
  // oxlint-disable-next-line typescript/no-explicit-any -- DrizzleDb is `any` in @wystack/db
  raw: any,
  draftId: string,
  touchedTables: AnyTable[],
): Promise<void> {
  for (const drizzleTable of touchedTables) {
    const tableName = getTableName(drizzleTable)
    const config = getTableConfig(drizzleTable)
    const schema = config.schema
    const draftRel = schema ? `"${schema}"."${tableName}__draft"` : `"${tableName}__draft"`
    const prefix = sql.raw(`DELETE FROM ${draftRel} WHERE "draft_id" = `)
    await raw.execute(sql`${prefix}${draftId}`)
  }
}

function normalizeRows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[]
  if (result && typeof result === 'object' && 'rows' in result) {
    return (result as { rows: Record<string, unknown>[] }).rows
  }
  return []
}
