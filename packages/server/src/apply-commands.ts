// @wystack/server — applyCommands engine (the command MECHANISM)
//
// `applyCommands` is the single write entry point for batched mutations. It is
// the generic substrate under DashFrame's Artifact write-side: a frozen-API
// primitive that knows NOTHING about concrete command types. It composes three
// existing pieces — `WyStackApp.runHandler` (typed dispatch against a supplied
// tracker), `DrizzleTracker.transaction` (atomic + Tag-tracked + rollback-emits-
// nothing), and the Tracker's `tablesWritten` set (the invalidation feed) —
// into a command bus with two modes:
//
//   - commit  — apply the whole batch atomically in ONE tracked transaction.
//               All-or-nothing. On success the merged `tablesWritten` is
//               returned so the caller flushes it to the existing invalidation
//               path (same set a single `app.call` mutation would produce).
//   - preview — apply every command FOR REAL inside the transaction (identical
//               code path to commit — not a simulator; trustworthiness comes
//               from sameness), capture what changed, then force a rollback so
//               nothing persists and no Tags emit.
//
// OUTER-TX EXTENSION (commit mode only): `ApplyCommandsOptions.tx` threads an
// already-open caller-supplied transaction handle into the engine. When supplied
// the engine does NOT open its own transaction — all commands run directly
// against `tx`, and the caller's transaction boundary governs atomicity. This
// makes it possible to combine `applyCommands` with caller-side bookkeeping
// (e.g. sweeping a durable command log) in a SINGLE commit, eliminating any
// crash window between the two. See `ApplyCommandsOptions.tx` for semantics.
//
// This is deliberately the mechanism only. The command VOCABULARY (concrete
// command paths, mutation-only validation policy, artifact-grouped PreviewDiff
// with real compute) is a separate layer (in DashFrame) that
// supplies the `path`s this engine dispatches. Keeping the seam clean keeps
// this engine a candidate for promotion to a generic WyStack primitive.
//
// CQRS plumbing follows standard command-bus patterns — a typed, ordered
// dispatch of command messages through one handler registry. Cf. NestJS CQRS
// (`CommandBus.execute`) and ts-cqs (`CommandHandler`); we intentionally do NOT
// reinvent those frameworks. This is a focused engine: one entry point, no
// middleware pipeline, no decorators.

import type { DrizzleTracker } from '@wystack/db'
import type { WyStackApp } from './create'

/**
 * One command in a batch envelope: a reference to a registered WyStack function
 * (`path`) plus its `args`. Mirrors the `app.call(path, args)` shape so a
 * command and a plain RPC dispatch identically.
 *
 * Client-generated-id invariant: ids are minted client-side and carried in
 * `args`, so a batch can reference an entity it created in an earlier command.
 * The engine needs no special handling for this beyond applying commands in
 * order within one transaction — an earlier insert is visible to a later
 * command because they share the same tx handle.
 *
 * `id` is an OPTIONAL client-minted correlation key. The engine treats it as an
 * opaque token — exactly like `args`, it never parses or interprets it — and
 * echoes it onto the matching `CommandResult.id`. It exists so a consumer can
 * map a result back to its command NOMINALLY (by id) rather than POSITIONALLY
 * (by array index), which matters for agent emit→validate→retry loops where a
 * batch may be filtered or partially retried and indices shift. Omit it and
 * correlation falls back to order — `results[i]` still pairs with `commands[i]`.
 */
export interface Command {
  id?: string
  path: string
  args: unknown
}

/**
 * One command's outcome: its handler return `value` plus the `id` echoed from
 * the source `Command` (undefined when the command carried none). `value` is
 * `unknown` because a vocabulary-free engine cannot know handler return types —
 * the typed vocabulary layer narrows it. Same value `app.call`
 * surfaces as `result`, so a batched command and a plain RPC to the same path
 * yield the same `value`.
 */
export interface CommandResult {
  id?: string
  value: unknown
}

/** Shared shape across both modes: which commands ran and what they touched. */
interface ApplyResultBase {
  /** Echo of the batch that was applied, in order. Read `.length` for the count. */
  commands: Command[]
  /**
   * Each command's outcome, in batch order — `results[i]` corresponds to
   * `commands[i]`, and each entry also carries the `id` echoed from its source
   * `Command` so a consumer can correlate by id instead of by index. A later
   * vocabulary command that needs a server-derived value (e.g. a created
   * entity's computed field) reads `results[i].value` here.
   */
  results: CommandResult[]
  /**
   * Union of every table written across the batch. In `commit` this is the set
   * the caller flushes to invalidation; in `preview` it is the set that WOULD
   * have flushed had the batch committed.
   */
  tablesWritten: Set<string>
}

/**
 * Result of a committed batch. `tablesWritten` is non-empty iff some command
 * wrote, and is what the caller hands to the invalidation source so reactive
 * reads re-fire once for the whole batch.
 */
export interface CommitResult extends ApplyResultBase {
  mode: 'commit'
}

/**
 * Result of a preview batch. Nothing persisted and no Tags emitted; the fields
 * describe what the commit WOULD have done. The artifact-grouped diff
 * (directNodes / affectedDownstream with real DuckDB compute) is a higher
 * layer's job — this generic result is intentionally vocabulary-free
 * (no artifact types leak in; a future wire layer picks its own encoding).
 */
export interface PreviewResult extends ApplyResultBase {
  mode: 'preview'
}

/** Discriminated on `mode` so callers narrow without a separate flag. */
export type ApplyResult = CommitResult | PreviewResult

export interface ApplyCommandsOptions {
  mode: 'commit' | 'preview'
  /** Per-batch context (auth, tenant) forwarded to every command's handler. */
  context?: Record<string, unknown>
  /**
   * ADDITIVE OPTIONAL — commit mode only.
   *
   * When supplied, `applyCommands` runs every command directly against this
   * already-open `DrizzleTracker` (a tx handle the CALLER opened) instead of
   * opening its own transaction. The caller's transaction boundary governs
   * atomicity: if the caller's tx rolls back, the command writes roll back too.
   *
   * PRIMARY USE CASE — atomic publish: the caller opens ONE transaction, calls
   * `applyCommands(app, log, { mode: 'commit', tx })` to replay the command
   * log, then performs bookkeeping (e.g. deleting the durable command log)
   * INSIDE THE SAME tx callback. If any step fails the whole tx rolls back,
   * eliminating the crash window between canonical commit and log sweep.
   *
   * CONTRACT (caller must hold):
   *   - `tx` is the DrizzleTracker handle from INSIDE an already-open transaction
   *     (i.e. the argument passed to `DrizzleTracker.transaction(async (tx) => ...)`).
   *   - `tablesWritten` on the returned `CommitResult` is snapshotted from
   *     `tx.tablesWritten` directly (not from an outer wrapper) immediately
   *     after command replay completes. It contains COMMAND-BATCH writes only —
   *     any bookkeeping writes the caller performs in the same tx AFTER
   *     `applyCommands` returns (e.g. the log delete) are intentionally
   *     excluded, so the caller flushes only command-relevant tables to
   *     invalidation. The caller must NOT flush this set to invalidation until
   *     AFTER the outer transaction resolves successfully — side effects
   *     (invalidation, pubsub) must never precede a durable commit.
   *   - Ignored when `mode === 'preview'` (preview manages its own rollback
   *     sentinel; threading an outer tx has no defined semantics there).
   */
  tx?: DrizzleTracker
}

/**
 * Sentinel thrown inside the preview transaction to force a rollback. The ONLY
 * rollback channel `DrizzleTracker.transaction` exposes is a throw (which also skips
 * the Tag merge — exactly preview's "emit nothing" requirement). We capture the
 * result on the sentinel so it survives the throw, then unwrap it outside the
 * transaction. This sentinel must never propagate as a real error — `applyCommands`
 * catches it by identity and returns normally.
 */
class PreviewRollback {
  constructor(
    public readonly results: CommandResult[],
    public readonly tablesWritten: Set<string>,
  ) {}
}

/**
 * Apply an ordered batch of commands as a single tracked transaction.
 *
 * @param app    the WyStack app whose function registry resolves command paths
 * @param batch  ordered commands; applied in array order within one transaction
 * @param opts   `mode: 'commit' | 'preview'` plus optional per-batch context
 *              and optional outer `tx` (commit mode only — see ApplyCommandsOptions.tx)
 *
 * The positional public signature `(app, batch, opts)` is FROZEN. The `opts`
 * bag is additive: new optional fields (like `tx`) extend it without breaking
 * existing call sites. Shape rationale:
 *   - `(app, batch, opts)` mirrors `app.call(path, args, context)` argument
 *     order (subject, payload, options) so the two entry points read alike.
 *   - `ApplyResult` is a discriminated union on `mode`, not a flag, so callers
 *     narrow `CommitResult` vs `PreviewResult` exhaustively.
 *   - The result is generic + vocabulary-free (no artifact types): a future
 *     DashFrame layer wraps it, it does not leak into this primitive.
 */
export async function applyCommands(
  app: WyStackApp,
  batch: Command[],
  opts: ApplyCommandsOptions,
): Promise<ApplyResult> {
  const { mode, context = {}, tx: outerTx } = opts

  if (mode === 'commit') {
    if (outerTx !== undefined) {
      // OUTER-TX PATH: the caller already opened a transaction and supplies the
      // tx-bound DrizzleTracker handle. Run all commands directly against it — no
      // new transaction is opened here; the caller's commit boundary governs.
      // This is the atomic-publish seam: replay + caller bookkeeping (e.g. log
      // sweep) share one commit, so there is no crash window between them.
      //
      // `tablesWritten` snapshots ONLY the delta introduced by this command
      // batch. The baseline is captured before `applyAll` so any tables the
      // caller wrote BEFORE calling `applyCommands` (bookkeeping, lock rows,
      // etc.) are excluded from the returned set. This upholds the
      // "COMMAND-BATCH writes only" contract — callers flush only command-
      // relevant tables to invalidation, not pre-existing bookkeeping writes.
      // The caller must NOT flush this set until AFTER the outer tx resolves.
      const tablesWrittenBefore = new Set(outerTx.tablesWritten)
      const results = await applyAll(app, batch, outerTx, context)
      const tablesWritten = new Set(
        [...outerTx.tablesWritten].filter((t) => !tablesWrittenBefore.has(t)),
      )
      return {
        mode: 'commit',
        commands: [...batch],
        results,
        tablesWritten,
      }
    }

    // SELF-CONTAINED PATH (no outer tx supplied): open our own transaction.
    // Outer tracker bound to the app's connection. Its `transaction` opens the
    // native tx; on commit it merges the inner tx tracker's writes up into
    // `outer.tablesWritten` (the call-scope set that reaches invalidation).
    // `applyCommands` is a peer of `app.call`, which likewise mints its own fresh
    // tracker per dispatch.
    const outer = app.createTracked()
    // Apply every command in order inside one transaction. Any throw rolls the
    // whole batch back (including commands applied before the failure) and the
    // tracked-transaction merge is skipped, so nothing flushes to invalidation.
    let results: CommandResult[] = []
    await outer.transaction(async (tx) => {
      results = await applyAll(app, batch, tx, context)
    })

    // Reached only on commit: `outer.tablesWritten` now holds the merged union
    // (the inner tx tracker's writes were merged up on commit).
    return {
      mode: 'commit',
      // Snapshot the batch — `results`/`tablesWritten` are defensively copied,
      // so copy `commands` too; otherwise a caller mutating its `batch` array
      // after the call would silently mutate `result.commands`.
      commands: [...batch],
      results,
      tablesWritten: new Set(outer.tablesWritten),
    }
  }

  // preview: apply-for-real-then-rollback. Same dispatch path as commit, but we
  // throw the sentinel after capturing the inner tx's `tablesWritten` so the
  // transaction rolls back (nothing persists, no Tags merge). We unwrap the
  // sentinel outside; a real command error is NOT a sentinel and propagates.
  // `opts.tx` is intentionally ignored in preview mode — preview manages its
  // own rollback sentinel and has no defined semantics for an outer tx handle.
  const previewOuter = app.createTracked()
  try {
    await previewOuter.transaction(async (tx) => {
      const results = await applyAll(app, batch, tx, context)
      // Snapshot the per-command results and the set that WOULD have flushed,
      // then force rollback via the sentinel. We read `tx.tablesWritten` (the
      // INNER tracker) here, not `previewOuter`: the merge into `previewOuter`
      // only happens on commit, which a preview never reaches — so `previewOuter`
      // would read empty.
      throw new PreviewRollback(results, new Set(tx.tablesWritten))
    })
  } catch (err) {
    if (err instanceof PreviewRollback) {
      return {
        mode: 'preview',
        commands: [...batch],
        results: err.results,
        tablesWritten: err.tablesWritten,
      }
    }
    // A genuine command failure during preview surfaces to the caller — preview
    // of an invalid batch should report the error, not a phantom success.
    throw err
  }

  // Defensive: the preview transaction callback always throws (the sentinel),
  // so this is reached only if a lowering somehow swallows the throw and commits.
  // Treat that as a contract violation rather than a silent phantom-commit.
  throw new Error('applyCommands: preview transaction did not roll back')
}

/**
 * Dispatch every command in order against the SUPPLIED tx tracker, so all
 * writes share one native transaction and accumulate into one Tag-set. Order is
 * load-bearing for the client-id invariant: a create must run before a later
 * command that references it.
 */
async function applyAll(
  app: WyStackApp,
  batch: Command[],
  tx: DrizzleTracker,
  context: Record<string, unknown>,
): Promise<CommandResult[]> {
  const results: CommandResult[] = []
  for (const cmd of batch) {
    const value = await app.runHandler(cmd.path, cmd.args, tx, context)
    // Echo the command's opaque correlation id onto its result; the engine
    // never interprets it, only carries it from input to output.
    results.push({ id: cmd.id, value })
  }
  return results
}
