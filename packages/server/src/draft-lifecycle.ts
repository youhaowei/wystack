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

import { resolvePkColumnName, type DraftDrizzleTracker } from '@wystack/db'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { getTableName, sql } from 'drizzle-orm'
import {
  applyCommands,
  type Command,
  type CommandResult,
  type CommitResult,
} from './apply-commands'
import type { WyStackApp } from './create'

// oxlint-disable-next-line typescript/no-explicit-any -- polymorphic Drizzle table, mirrors drizzle-tracker.ts
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
  /**
   * Invalidation tags for the shadow tables this draft ACTUALLY wrote rows into,
   * accumulated from what the tracker reported on each `append`.
   *
   * Publish and discard both sweep the overlay through `tx.raw` / a raw handle,
   * which is UNTRACKED — the sweep never lands in any `tablesWritten` set. But a
   * draft-scoped subscription watches exactly these tags (the draft read coalesce
   * registers both the canonical and the shadow name in `tablesRead`, so the
   * router's read∩write intersection can fire), and after a sweep its rows are
   * gone. Naming them explicitly is what stops a draft-scoped client from sitting
   * on a swept overlay forever.
   *
   * Taken from the tracker rather than rebuilt from `touchedTables`, for two
   * reasons: `touchedTables` also records tables the draft only READ (a
   * `from(t)…delete()` routes through `from`, so reads cannot be excluded there),
   * which would emit tags for shadows that never had a row; and a reconstructed
   * `${name}__draft` string has to match `@wystack/db`'s own tag format exactly
   * or it silently matches nothing. Copying the tracker's own tags cannot drift.
   */
  shadowWrites: Set<string>
  /** Per-batch context threaded to publish's replay (auth/tenant). */
  context: Record<string, unknown>
  /**
   * Serialization chain for this draft — the tail of a promise queue every
   * mutating entry point (`append`/`publish`/`discard`) chains onto, so two
   * callers can never interleave their awaits against this entry. Without it,
   * two concurrent `append`s interleave their overlay writes and splice their
   * commands into each other's log order. Never rejects (see `withDraftLock`),
   * so one failed operation cannot wedge the draft.
   */
  lock: Promise<void>
  /**
   * Non-`'open'` for as long as a TERMINAL operation (publish or discard) is in
   * flight — both end by removing the entry from `drafts`, so work admitted
   * while one is running would run against a detached entry and vanish. Set
   * SYNCHRONOUSLY, before the first await, so a concurrent caller observes the
   * claim rather than racing into the window. Reset to `'open'` if the terminal
   * operation fails — a failed publish (or discard) leaves the draft live and
   * retryable.
   */
  state: 'open' | 'publishing' | 'discarding'
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
   *
   * Concurrency: appends on ONE draft are serialized FIFO, so two in-flight
   * batches cannot interleave their overlay writes or their log positions.
   * An append that arrives while `publish` is in flight REJECTS (see `publish`).
   */
  append(draftId: string, batch: DraftCommand[]): Promise<CommandResult[]>
  /**
   * PUBLISH = replay the ordered command log onto canonical via
   * `applyCommands(app, log, {commit})`, calling `resolve(log)` IMMEDIATELY
   * before the commit (the ONLY app injection inside publish — it binds
   * late-bound operands). Atomic via `applyCommands`'s tracked tx. The
   * draft's shadow + registry entry are cleared on success.
   *
   * Invalidation is the LIFECYCLE's job, not the host's: publish emits the
   * canonical tags from the replay plus the `<table>__draft` tags for the sweep
   * (untracked, so `applyCommands` cannot report them), once the transaction has
   * durably committed. `append` and `discard` emit too — every entry point that
   * writes announces its own writes, so no consumer can forget to and leave
   * subscriptions silently stale. `tablesWritten` is still returned for hosts
   * that want the set for their own bookkeeping.
   *
   * Publish CLAIMS the draft for its whole duration: once entered, any further
   * `append`, `discard`, or `publish` on the same draft rejects rather than
   * racing the snapshot-then-sweep window (work admitted in that window used to
   * be applied to the overlay and then silently destroyed). Work already
   * in flight or queued when the claim is taken still runs first, and publishes
   * with this batch. On FAILURE the claim is released and the draft stays live
   * and retryable.
   */
  publish(draftId: string, resolve?: ResolveHook): Promise<CommitResult>
  /**
   * Drop the draft: clear its shadow rows and forget its registry entry.
   * Like `publish`, discard CLAIMS the draft synchronously for its duration —
   * it too detaches the entry, so later `append`/`discard`/`publish` calls are
   * rejected rather than racing the sweep. Rejects if the draft is already
   * mid-publish or mid-discard.
   */
  discard(draftId: string): Promise<void>
  /**
   * Detect whether canonical moved under the draft. Returns the two generic
   * signals; makes NO policy decision. Reads the draft's touched cells straight
   * from the `<table>__draft` shadow (the `(draftId, id)` keys), then asks the
   * app's `VersionProbe` which canonical also wrote.
   */
  detectConflict(draftId: string): Promise<ConflictReport>
  /** Read-only peek at a draft's current command log (post-compaction). */
  getLog(draftId: string): DraftCommand[]
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

  /**
   * Resolve a draft that is accepting work. Rejecting while a TERMINAL operation
   * is in flight is what makes the lost-write window (#88) impossible: both
   * `publish` and `discard` await (the `resolve` hook and commit transaction;
   * the shadow sweep) and then delete the entry. Work that landed in that window
   * used to be applied to the overlay, missed the snapshot, and was then
   * destroyed along with the entry — silently, with a success returned to its
   * caller. Now it fails loud instead.
   */
  function requireOpen(draftId: string): DraftEntry {
    const entry = require(draftId)
    if (entry.state !== 'open') {
      throw new Error(
        `draft lifecycle: draft "${draftId}" is ${entry.state} — retry once it settles`,
      )
    }
    return entry
  }

  /**
   * Run `fn` with exclusive access to one draft, queued FIFO behind whatever is
   * already in flight on it. Combined with the `requireOpen` check — which every
   * caller passes BEFORE queueing — this yields the invariant that makes the
   * queue safe: anything running or queued when `publish` or `discard` claims
   * the draft was admitted before the claim and therefore runs BEFORE it, and
   * anything arriving after is rejected outright. Nothing can ever run against
   * an entry a terminal operation has already detached from `drafts`.
   *
   * Note that a queued `fn` STILL RUNS when the operation ahead of it failed —
   * the chain deliberately swallows rejections so one failure cannot wedge the
   * draft. So a publish queued behind a mid-batch-failed append publishes that
   * append's partially-applied commands. That is the existing append contract
   * ("the conducting app owns recovery"), just reached without an intervening
   * app decision; issue the publish after awaiting the append if that matters.
   */
  function withDraftLock<T>(entry: DraftEntry, fn: () => Promise<T>): Promise<T> {
    const run = entry.lock.then(fn)
    // Swallow on the CHAIN only (the caller still sees the rejection via `run`),
    // so a failed operation does not poison every operation queued behind it.
    entry.lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  return {
    open(baseVersion, openOpts = {}) {
      const draftId = mintDraftId()
      drafts.set(draftId, {
        baseVersion,
        log: [],
        touchedTables: new Map(),
        shadowWrites: new Set(),
        context: openOpts.context ?? {},
        lock: Promise.resolve(),
        state: 'open',
      })
      return draftId
    },

    async append(draftId, batch) {
      const entry = requireOpen(draftId)
      for (const command of batch) {
        const definition = app.functions.get(command.path)
        if (!definition) throw new Error(`Unknown function: ${command.path}`)
        if (definition.type !== 'mutation') {
          throw new Error(`Draft command ${command.path} must reference a mutation`)
        }
      }
      return withDraftLock(entry, async () => {
        // Route writes through the draft handle so `ctx.db.into/update/delete`
        // lands in the `<table>__draft` overlay. The recording wrapper captures
        // the Drizzle table OBJECTS written, keyed by schema-qualified name, so
        // detection + teardown can introspect schema/PK without a global schema registry.
        const draftDb: DraftDrizzleTracker = recordTouchedTables(
          app.createTracked().withDraft(draftId),
          entry.touchedTables,
        )
        const results: CommandResult[] = []
        try {
          for (const cmd of batch) {
            // Snapshot BEFORE running the handler, and run the handler on the
            // SNAPSHOT. The log is the publish unit (replayed verbatim later);
            // storing the caller's object by reference would let a post-append
            // mutation of the batch or its `args` silently change what `publish`
            // replays — diverging the canonical commit from the draft preview
            // that was executed here.
            //
            // Snapshotting first is what makes the two halves agree even when the
            // clone FAILS. `structuredClone` throws on a non-cloneable value (a
            // function, a class instance with a getter that throws), and a jsonb
            // argument validates as `unknown`, so such a value reaches here
            // through ordinary validation. Cloning after the handler ran meant a
            // durable overlay row whose command never reached the log — publish
            // would then silently omit it. Same defect family as #88: a write
            // with nothing to replay. Cloning first moves the failure ahead of
            // any write, so the batch aborts with the draft untouched.
            const snapshot = snapshotCommand(cmd)
            const value = await app.runHandler(snapshot.path, snapshot.args, draftDb, entry.context)
            results.push({ id: cmd.id, value })
            entry.log.push(snapshot)
          }
        } finally {
          // Announce the overlay writes, and remember them: publish and discard
          // sweep those same shadow tables through an untracked raw handle, so
          // this is the only place the tags are ever reported.
          //
          // In a `finally` because append is NOT atomic across a batch — each
          // command auto-commits on its own, so a mid-batch throw still leaves
          // earlier writes durable, and a draft-scoped subscription must see
          // them. Guarded on size so a no-write batch never triggers a recompute
          // storm.
          if (draftDb.tablesWritten.size > 0) {
            for (const tag of draftDb.tablesWritten) entry.shadowWrites.add(tag)
            app.emit(draftDb.tablesWritten)
          }
        }
        // Compact the accumulated log to net effect (no-op for keyless commands).
        entry.log = compactLog(entry.log)
        return results
      })
    },

    async publish(draftId, resolve) {
      const entry = requireOpen(draftId)
      // CLAIM the draft synchronously, before any await: from here on `append`,
      // `discard`, and a second `publish` are rejected rather than racing the
      // snapshot-then-delete window below. Ordering matters — a claim taken
      // after the first await is not a claim.
      entry.state = 'publishing'
      try {
        return await withDraftLock(entry, async () => {
          // Snapshot INSIDE the lock, so an append admitted before the claim has
          // already landed its commands and they publish with this batch.
          //
          // Bind late-bound operands immediately before commit — the ONLY app
          // injection inside publish. Identity if no hook supplied.
          const boundLog = resolve ? await resolve([...entry.log]) : [...entry.log]
          const touched = [...entry.touchedTables.values()]

          // ATOMIC PUBLISH: open ONE outer transaction so command-log
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
          // `DrizzleTracker.transaction` is generic over its callback return type — we
          // capture the CommitResult directly rather than via a non-local variable.
          const result = await app.createTracked().transaction(async (tx) => {
            // Replay the command log against the caller-supplied tx handle. The
            // outer-tx seam (applyCommands opts.tx) routes all
            // command writes through this same handle — no inner transaction is
            // opened; the outer's commit boundary governs.
            const committed = (await applyCommands(app, boundLog, {
              mode: 'commit',
              context: entry.context,
              tx,
            })) as CommitResult
            // Shadow-sweep inside the SAME tx: shadow rows disappear atomically
            // with the canonical commit. On failure the outer tx rolls back both.
            // `tx.raw` is the native Drizzle handle bound to this transaction.
            await clearShadow(tx.raw, draftId, touched)
            return committed
          })

          // Outer transaction committed. Remove the in-memory registry entry now
          // that the canonical write is durable and the shadow is swept. This is
          // post-commit — a crash here is harmless (the map is ephemeral and will
          // be empty on restart regardless). Deleting AFTER commit (not before)
          // preserves the entry for a retry if the outer tx rolls back.
          drafts.delete(draftId)

          // Fan out AFTER the commit — canonical tags from the replay, shadow
          // tags for the sweep (untracked, so `applyCommands` cannot report it).
          //
          // The lifecycle emits rather than deferring to the host. `applyCommands`
          // defers because it may run inside a caller-owned transaction and cannot
          // know when the write became durable; publish OWNS its commit boundary,
          // so that reason does not apply here — and `app.emit` names draft
          // publish as an intended caller. Leaving it to the host made a forgotten
          // flush indistinguishable from success: canonical committed, every live
          // subscription silently stale.
          const tags = new Set([...result.tablesWritten, ...entry.shadowWrites])
          if (tags.size > 0) app.emit(tags)
          return result
        })
      } catch (err) {
        // A failed publish leaves the draft LIVE and retryable (the outer tx
        // rolled back and the entry was never deleted) — so hand the claim back,
        // or the draft would be permanently unappendable and undiscardable.
        entry.state = 'open'
        throw err
      }
    },

    async discard(draftId) {
      const entry = requireOpen(draftId)
      // CLAIM the draft synchronously, for the same reason `publish` does:
      // discard also ends by detaching the entry, so an `append` admitted while
      // the sweep is in flight would write shadow rows for a draft that no
      // longer exists — and report success. Work admitted BEFORE the claim still
      // runs first (and is then discarded, which is what the caller asked for).
      entry.state = 'discarding'
      try {
        return await withDraftLock(entry, async () => {
          // Discard has no replay to be atomic with, but the sweep itself still
          // needs a commit boundary: `clearShadow` issues one DELETE per
          // touched table, and each statement auto-commits on its own
          // connection. A multi-table draft whose sweep fails partway (a later
          // DELETE errors) would otherwise leave the EARLIER deletes durably
          // committed — visible state changed — while the catch below resets
          // the draft to 'open' and no invalidation is ever emitted for those
          // tables. Subscribers keep serving rows that are already gone.
          // Wrapping the sweep in one transaction makes it all-or-nothing:
          // either every touched shadow table clears (and its tag reaches the
          // emit below) or none does, and the draft stays live/retryable.
          const touched = [...entry.touchedTables.values()]
          await app.createTracked().transaction(async (tx) => {
            await clearShadow(tx.raw, draftId, touched)
          })
          drafts.delete(draftId)
          // Canonical is untouched, but the overlay rows are gone — draft-scoped
          // subscriptions are stale and must be told. Empty for a read-only
          // draft: the sweep found nothing, so nobody's result changed.
          if (entry.shadowWrites.size > 0) app.emit(entry.shadowWrites)
        })
      } catch (err) {
        // Symmetric with publish: a failed sweep leaves the draft live, so hand
        // the claim back or it becomes permanently unusable.
        entry.state = 'open'
        throw err
      }
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
