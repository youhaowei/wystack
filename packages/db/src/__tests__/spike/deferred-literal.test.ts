/**
 * YW-153 SPIKE — Deferred Literal Operand
 *
 * Question: Does a `{ kind: "deferred", ref: { categoryRef } }` operand survive
 * all six pipeline stages of a SetInsightFilter command? Where does it break?
 *
 * Run: bun test spike/deferred-literal.test.ts
 */

import { describe, test, expect, beforeEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { sql } from 'drizzle-orm'

// ─── Type definitions (the proposed Artifact API operand shape) ───────────────

/** An operand carrying a literal value — the normal (author-had-it) case. */
interface ValueOperand {
  kind: 'value'
  v: unknown
}

/**
 * An operand whose value was NOT available to the agent at authoring time.
 * Three sub-shapes:
 *   columnRef   — the operand IS another column in the query (no literal needed)
 *   categoryRef — opaque handle minted by the privacy gate; resolved at execution
 *   prompt      — bound by the human at publish time
 */
interface DeferredOperand {
  kind: 'deferred'
  ref:
    | { columnRef: string }       // fieldId pointing to another column
    | { categoryRef: string }     // opaque handle from the privacy gate
    | { prompt: string }          // human fills in at publish
}

type Operand = ValueOperand | DeferredOperand

// ─── SetInsightFilter command (the command under test) ────────────────────────

interface SetInsightFilterCommand {
  type: 'SetInsightFilter'
  insightId: string
  field: string
  op: 'eq' | 'ne' | 'gt' | 'lt' | 'in'
  operand: Operand
}

// ─── Stage 1: Agent emits ─────────────────────────────────────────────────────
//
// The agent hardcodes a command with a categoryRef operand. This simulates
// a privacy gate having minted handle "h_xyz" for a sensitive column (e.g. "region").

function agentEmitsCommand(): SetInsightFilterCommand {
  return {
    type: 'SetInsightFilter',
    insightId: 'insight-001',
    field: 'region',
    op: 'eq',
    operand: {
      kind: 'deferred',
      ref: { categoryRef: 'h_xyz' },
    },
  }
}

// ─── Stage 2: Command validation ─────────────────────────────────────────────
//
// What should validation check for a deferred operand?
// Key question: should validation REQUIRE that categoryRef handles are registered,
// or should it accept any opaque string?

type ValidationResult = { ok: true } | { ok: false; error: string }

function validateCommand(cmd: SetInsightFilterCommand): ValidationResult {
  if (!cmd.insightId || typeof cmd.insightId !== 'string') {
    return { ok: false, error: 'insightId must be a non-empty string' }
  }
  if (!cmd.field || typeof cmd.field !== 'string') {
    return { ok: false, error: 'field must be a non-empty string' }
  }
  if (!['eq', 'ne', 'gt', 'lt', 'in'].includes(cmd.op)) {
    return { ok: false, error: `unknown op: ${cmd.op}` }
  }

  const { operand } = cmd
  if (operand.kind === 'value') {
    // Value operands: v must be present (null IS a valid value for IS NULL semantics)
    if (!('v' in operand)) {
      return { ok: false, error: 'value operand missing v field' }
    }
    return { ok: true }
  }

  if (operand.kind === 'deferred') {
    const { ref } = operand
    if ('columnRef' in ref) {
      if (!ref.columnRef) return { ok: false, error: 'columnRef must be non-empty' }
      return { ok: true }
    }
    if ('categoryRef' in ref) {
      // FINDING A: Validation can only check shape, not that the handle exists.
      // The handle registry lives in the privacy gate — not available at
      // command-validation time. Validation CANNOT eagerly reject unknown handles
      // without coupling to the privacy gate. It can only check the string is present.
      if (!ref.categoryRef) return { ok: false, error: 'categoryRef must be non-empty' }
      return { ok: true }
    }
    if ('prompt' in ref) {
      if (!ref.prompt) return { ok: false, error: 'prompt must be non-empty' }
      return { ok: true }
    }
    return { ok: false, error: 'deferred operand ref has no recognized shape' }
  }

  return { ok: false, error: `unknown operand kind` }
}

// ─── Stage 3: Draft storage (JSON round-trip) ─────────────────────────────────
//
// Commands are stored as JSONB in the draft table. Does the operand shape survive?

interface DraftRow {
  id: string
  insight_id: string
  command: SetInsightFilterCommand   // stored as JSONB
}

async function storeDraft(
  db: ReturnType<typeof drizzle>,
  cmd: SetInsightFilterCommand,
): Promise<string> {
  const id = `draft-${Date.now()}`
  await db.execute(
    sql`INSERT INTO drafts (id, insight_id, command) VALUES (${id}, ${cmd.insightId}, ${JSON.stringify(cmd)}::jsonb)`,
  )
  return id
}

async function loadDraft(
  db: ReturnType<typeof drizzle>,
  id: string,
): Promise<SetInsightFilterCommand | null> {
  const rows = await db.execute(sql`SELECT command FROM drafts WHERE id = ${id}`)
  if (rows.rows.length === 0) return null
  // PGlite returns rows as objects keyed by column name (not positional arrays).
  // JSONB is automatically parsed back to a JS object by the PGlite driver.
  const raw = (rows.rows[0] as { command: unknown }).command
  return raw as SetInsightFilterCommand
}

// ─── Stage 4: PREVIEW rendering — THE HARD ONE ───────────────────────────────
//
// Building SQL for a filter WHERE clause when the operand is an unbound categoryRef.
// Three strategies explored:
//   A) SKIP-PREDICATE  — drop the filter entirely, return full unfiltered results
//   B) PLACEHOLDER-SQL — use a sentinel literal ('__DEFERRED__') to mark the gap
//   C) ERROR           — refuse to execute preview, surface an error
//
// This spike tests all three and records what each produces.

type PreviewStrategy = 'skip-predicate' | 'placeholder-sql' | 'error'

/** Resolve a categoryRef → real value. Returns null if unbound. */
function resolveHandle(ref: string, registry: Map<string, unknown>): unknown | null {
  return registry.has(ref) ? registry.get(ref)! : null
}

interface PreviewResult {
  strategy: PreviewStrategy
  rows: unknown[]
  sql: string
  warning?: string
  error?: string
}

async function runPreview(
  db: ReturnType<typeof drizzle>,
  cmd: SetInsightFilterCommand,
  handleRegistry: Map<string, unknown>,
  strategy: PreviewStrategy,
): Promise<PreviewResult> {
  const { operand } = cmd

  // STRATEGY: resolve operand to a SQL-safe value or handle the deferred case
  let resolvedValue: unknown | null = null
  let isDeferred = false

  if (operand.kind === 'value') {
    resolvedValue = operand.v
  } else if (operand.kind === 'deferred') {
    const { ref } = operand
    if ('columnRef' in ref) {
      // columnRef: the operand IS a column — no literal needed, use col = col form
      // Slightly unusual for eq but valid for "field = other_field" semantics
      const queryText = `SELECT * FROM sales WHERE ${cmd.field} = ${ref.columnRef}`
      const result = await db.execute(sql.raw(queryText))
      return { strategy: 'skip-predicate', rows: result.rows, sql: queryText }
    }
    if ('categoryRef' in ref) {
      const resolved = resolveHandle(ref.categoryRef, handleRegistry)
      if (resolved !== null) {
        resolvedValue = resolved
      } else {
        isDeferred = true
      }
    }
    if ('prompt' in ref) {
      isDeferred = true
    }
  }

  if (!isDeferred) {
    // Normal bound case — execute with real value
    const queryText = `SELECT * FROM sales WHERE ${cmd.field} = '${resolvedValue}'`
    const result = await db.execute(sql.raw(queryText))
    return { strategy: 'skip-predicate', rows: result.rows, sql: queryText }
  }

  // ── DEFERRED and UNBOUND: apply the strategy ──────────────────────────────
  switch (strategy) {
    case 'skip-predicate': {
      // Drop the filter. Return all rows. Risk: chart looks wrong (too much data).
      const queryText = `SELECT * FROM sales`
      const result = await db.execute(sql.raw(queryText))
      return {
        strategy,
        rows: result.rows,
        sql: queryText,
        warning: `Filter on '${cmd.field}' skipped — operand unbound (handle: ${
          'categoryRef' in (operand as DeferredOperand).ref
            ? ((operand as DeferredOperand).ref as { categoryRef: string }).categoryRef
            : 'unknown'
        })`,
      }
    }

    case 'placeholder-sql': {
      // FINDING B: You CANNOT put an opaque handle literal in a WHERE clause.
      // The DB will either return 0 rows (no match) or error (type mismatch).
      // Using '__DEFERRED__' as a sentinel produces a real SQL query that
      // executes but returns 0 rows — which looks like "no data" to the chart.
      // This is SILENT and WRONG. It's not a useful preview.
      const sentinel = '__DEFERRED__'
      const queryText = `SELECT * FROM sales WHERE ${cmd.field} = '${sentinel}'`
      const result = await db.execute(sql.raw(queryText))
      return {
        strategy,
        rows: result.rows,
        sql: queryText,
        warning: `Placeholder sentinel used — 0 rows returned, chart will appear empty`,
      }
    }

    case 'error': {
      return {
        strategy,
        rows: [],
        sql: '-- preview blocked: unbound deferred operand',
        error: `Cannot render preview: filter on '${cmd.field}' has unbound deferred operand (categoryRef handle not yet resolved). Bind the operand or skip the filter to preview.`,
      }
    }
  }
}

// ─── Stage 5: User binds at publish ──────────────────────────────────────────
//
// Replace the handle with a real value, producing a ValueOperand.

function bindOperand(
  cmd: SetInsightFilterCommand,
  handleRegistry: Map<string, unknown>,
): SetInsightFilterCommand {
  const { operand } = cmd
  if (operand.kind !== 'deferred') return cmd
  const { ref } = operand
  if (!('categoryRef' in ref)) return cmd

  const resolved = resolveHandle(ref.categoryRef, handleRegistry)
  if (resolved === null) {
    throw new Error(`Cannot bind: handle '${ref.categoryRef}' not in registry`)
  }

  return {
    ...cmd,
    operand: { kind: 'value', v: resolved },
  }
}

// ─── Stage 6: SQL executes with bound value ───────────────────────────────────

async function executeBound(
  db: ReturnType<typeof drizzle>,
  cmd: SetInsightFilterCommand,
): Promise<{ rows: unknown[]; sql: string }> {
  if (cmd.operand.kind !== 'value') {
    throw new Error('Command must be fully bound before execution')
  }
  const queryText = `SELECT * FROM sales WHERE ${cmd.field} = '${cmd.operand.v}'`
  const result = await db.execute(sql.raw(queryText))
  return { rows: result.rows, sql: queryText }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('YW-153: Deferred literal operand pipeline', () => {
  let pg: PGlite
  let db: ReturnType<typeof drizzle>

  beforeEach(async () => {
    pg = new PGlite()
    db = drizzle(pg)

    // Set up: a tiny sales table with a sensitive 'region' column
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS sales (
        id SERIAL PRIMARY KEY,
        region TEXT NOT NULL,
        amount INTEGER NOT NULL
      )
    `)
    await db.execute(sql`DELETE FROM sales`)
    await db.execute(sql`INSERT INTO sales (region, amount) VALUES ('us-west', 1200)`)
    await db.execute(sql`INSERT INTO sales (region, amount) VALUES ('eu-central', 800)`)
    await db.execute(sql`INSERT INTO sales (region, amount) VALUES ('us-east', 500)`)

    // Draft storage table
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY,
        insight_id TEXT NOT NULL,
        command JSONB NOT NULL
      )
    `)
    await db.execute(sql`DELETE FROM drafts`)
  })

  // ── STAGE 1: Agent emits ──────────────────────────────────────────────────

  test('Stage 1 — agent emits command with categoryRef operand', () => {
    const cmd = agentEmitsCommand()
    expect(cmd.type).toBe('SetInsightFilter')
    expect(cmd.operand.kind).toBe('deferred')
    const operand = cmd.operand as DeferredOperand
    expect('categoryRef' in operand.ref).toBe(true)
    expect((operand.ref as { categoryRef: string }).categoryRef).toBe('h_xyz')
    console.log('[Stage 1] Command emitted:', JSON.stringify(cmd, null, 2))
  })

  // ── STAGE 2: Command validation ───────────────────────────────────────────

  test('Stage 2 — deferred operand passes validation (shape-only check)', () => {
    const cmd = agentEmitsCommand()
    const result = validateCommand(cmd)
    expect(result.ok).toBe(true)
    console.log('[Stage 2] Validation result:', result)
  })

  test('Stage 2 — validation rejects empty categoryRef string', () => {
    const cmd: SetInsightFilterCommand = {
      type: 'SetInsightFilter',
      insightId: 'insight-001',
      field: 'region',
      op: 'eq',
      operand: { kind: 'deferred', ref: { categoryRef: '' } },
    }
    const result = validateCommand(cmd)
    expect(result.ok).toBe(false)
    console.log('[Stage 2] Empty-ref rejection:', result)
  })

  test('Stage 2 — validation CANNOT detect unknown handles (finding: shape-only)', () => {
    // Even "h_totally_fake_and_unregistered" passes validation — we cannot
    // reach into the privacy gate from here.
    const cmd: SetInsightFilterCommand = {
      type: 'SetInsightFilter',
      insightId: 'insight-001',
      field: 'region',
      op: 'eq',
      operand: { kind: 'deferred', ref: { categoryRef: 'h_totally_fake' } },
    }
    const result = validateCommand(cmd)
    expect(result.ok).toBe(true) // shape is valid! handle existence is NOT checked.
    console.log(
      '[Stage 2] FINDING: unknown handle passes validation —',
      'validation is shape-only, not registry-aware',
    )
  })

  // ── STAGE 3: Draft stores ─────────────────────────────────────────────────

  test('Stage 3 — deferred operand round-trips through JSONB storage', async () => {
    const cmd = agentEmitsCommand()
    const id = await storeDraft(db, cmd)
    const loaded = await loadDraft(db, id)

    expect(loaded).not.toBeNull()
    expect(loaded!.type).toBe('SetInsightFilter')
    expect(loaded!.operand.kind).toBe('deferred')
    const operand = loaded!.operand as DeferredOperand
    expect('categoryRef' in operand.ref).toBe(true)
    expect((operand.ref as { categoryRef: string }).categoryRef).toBe('h_xyz')
    console.log('[Stage 3] Round-tripped command from JSONB:', JSON.stringify(loaded, null, 2))
    console.log('[Stage 3] FINDING: JSONB survives intact — no issues here.')
  })

  // ── STAGE 4: Preview renders — THE HARD ONE ───────────────────────────────

  test('Stage 4 — skip-predicate: unfiltered data returned (misleading)', async () => {
    const cmd = agentEmitsCommand()
    const registry = new Map<string, unknown>() // empty — handle unbound

    const result = await runPreview(db, cmd, registry, 'skip-predicate')
    console.log('[Stage 4 skip-predicate]', {
      sql: result.sql,
      rowCount: result.rows.length,
      warning: result.warning,
    })

    // skip-predicate returns ALL rows — chart shows unfiltered data
    expect(result.rows.length).toBe(3)
    expect(result.warning).toContain('skipped')
    console.log(
      '[Stage 4] FINDING: skip-predicate returns all rows.',
      'The chart preview SILENTLY shows unfiltered data.',
      'No visual indicator that a filter is pending.',
      'This is confusing — the author sees data but the filter is not applied.',
    )
  })

  test('Stage 4 — placeholder-sql: sentinel produces 0 rows (worse than skip)', async () => {
    const cmd = agentEmitsCommand()
    const registry = new Map<string, unknown>()

    const result = await runPreview(db, cmd, registry, 'placeholder-sql')
    console.log('[Stage 4 placeholder-sql]', {
      sql: result.sql,
      rowCount: result.rows.length,
      warning: result.warning,
    })

    // The sentinel literal __DEFERRED__ matches no row — chart is empty
    expect(result.rows.length).toBe(0)
    expect(result.warning).toContain('empty')
    console.log(
      '[Stage 4] FINDING: placeholder-sql produces 0 rows.',
      'Chart appears as "no data" — even more misleading than skip-predicate.',
      'Author cannot tell if their filter is correct or the handle is just unbound.',
    )
  })

  test('Stage 4 — error strategy: preview blocked with clear message', async () => {
    const cmd = agentEmitsCommand()
    const registry = new Map<string, unknown>()

    const result = await runPreview(db, cmd, registry, 'error')
    console.log('[Stage 4 error]', {
      sql: result.sql,
      error: result.error,
    })

    expect(result.error).toContain('unbound deferred operand')
    expect(result.rows.length).toBe(0)
    console.log(
      '[Stage 4] FINDING: error strategy surfaces the gap clearly.',
      'Author knows exactly why there is no preview.',
      'BUT: error is a hard stop — author cannot see any chart at all.',
    )
  })

  test('Stage 4 — with bound registry: preview executes normally', async () => {
    const cmd = agentEmitsCommand()
    // Privacy gate resolves the handle at preview time (e.g. user is in us-west org)
    const registry = new Map<string, unknown>([['h_xyz', 'us-west']])

    const result = await runPreview(db, cmd, registry, 'skip-predicate')
    console.log('[Stage 4 bound]', {
      sql: result.sql,
      rowCount: result.rows.length,
    })

    // With a bound registry, preview works correctly
    expect(result.rows.length).toBe(1)
    console.log('[Stage 4] FINDING: When the handle IS resolvable at preview time, everything works.')
  })

  // ── STAGE 5: User binds at publish ───────────────────────────────────────

  test('Stage 5 — bind replaces deferred operand with value operand', () => {
    const cmd = agentEmitsCommand()
    const registry = new Map<string, unknown>([['h_xyz', 'eu-central']])

    const bound = bindOperand(cmd, registry)
    expect(bound.operand.kind).toBe('value')
    expect((bound.operand as ValueOperand).v).toBe('eu-central')
    console.log('[Stage 5] Bound command:', JSON.stringify(bound, null, 2))
  })

  test('Stage 5 — binding an unknown handle throws at bind time', () => {
    const cmd = agentEmitsCommand()
    const registry = new Map<string, unknown>() // h_xyz not registered

    expect(() => bindOperand(cmd, registry)).toThrow("Cannot bind: handle 'h_xyz' not in registry")
    console.log('[Stage 5] FINDING: unbound handle throws at publish — correct gating behavior.')
  })

  // ── STAGE 6: SQL executes with bound value ────────────────────────────────

  test('Stage 6 — bound command executes correctly in SQL', async () => {
    const cmd = agentEmitsCommand()
    const registry = new Map<string, unknown>([['h_xyz', 'eu-central']])

    const bound = bindOperand(cmd, registry)
    const { rows, sql: queryText } = await executeBound(db, bound)

    console.log('[Stage 6]', { sql: queryText, rowCount: rows.length, rows })
    expect(rows.length).toBe(1)
    // Row 0 is the eu-central row with amount 800
  })

  test('Stage 6 — attempting to execute unbound command throws', async () => {
    const cmd = agentEmitsCommand() // still deferred

    expect(async () => await executeBound(db, cmd)).toThrow(
      'Command must be fully bound before execution',
    )
    console.log('[Stage 6] FINDING: execution correctly refuses unbound commands.')
  })

  // ── COMBINED WALKTHROUGH: all six stages in sequence ─────────────────────

  test('Full pipeline walk: emit → validate → store → preview(error) → bind → execute', async () => {
    console.log('\n=== FULL PIPELINE WALK ===')

    // Stage 1: emit
    const cmd = agentEmitsCommand()
    console.log('[1] Emitted:', cmd.type, 'operand kind:', cmd.operand.kind)

    // Stage 2: validate
    const validation = validateCommand(cmd)
    expect(validation.ok).toBe(true)
    console.log('[2] Validation:', validation.ok ? 'PASS (shape-only)' : 'FAIL')

    // Stage 3: store
    const draftId = await storeDraft(db, cmd)
    const loaded = await loadDraft(db, draftId)
    expect(loaded).not.toBeNull()
    expect((loaded!.operand as DeferredOperand).ref).toHaveProperty('categoryRef', 'h_xyz')
    console.log('[3] JSONB round-trip: OK, handle preserved as opaque string')

    // Stage 4: preview with no registry (unbound) — use error strategy
    const emptyRegistry = new Map<string, unknown>()
    const preview = await runPreview(db, loaded!, emptyRegistry, 'error')
    expect(preview.error).toBeDefined()
    console.log('[4] Preview (unbound, error strategy):', preview.error)

    // Stage 4b: preview with registry (bound at display time)
    const displayRegistry = new Map<string, unknown>([['h_xyz', 'us-west']])
    const previewBound = await runPreview(db, loaded!, displayRegistry, 'skip-predicate')
    expect(previewBound.rows.length).toBe(1)
    console.log('[4b] Preview (handle resolved from context):', previewBound.rows.length, 'rows')

    // Stage 5: bind for publish
    const publishRegistry = new Map<string, unknown>([['h_xyz', 'eu-central']])
    const bound = bindOperand(loaded!, publishRegistry)
    expect(bound.operand.kind).toBe('value')
    console.log('[5] Bound operand:', JSON.stringify(bound.operand))

    // Stage 6: execute
    const result = await executeBound(db, bound)
    expect(result.rows.length).toBe(1)
    console.log('[6] Execution: OK,', result.rows.length, 'row(s) returned, SQL:', result.sql)

    console.log('=== PIPELINE COMPLETE ===\n')
  })

  // ── FROZEN-API REGRET RISK: union shape analysis ──────────────────────────

  test('API shape regret risk: three-way ref union vs single discriminant', () => {
    // The current spec uses: ref: { columnRef } | { categoryRef } | { prompt }
    // This means consumers must check for three different keys.
    // A value operand already has kind: "value" | "deferred" at the top level.
    // The ref sub-union adds a SECOND discriminant decision point nested inside.

    // Scenario: code that needs to distinguish the three deferred sub-types
    function classifyRef(op: DeferredOperand): string {
      const { ref } = op
      if ('columnRef' in ref) return 'column'
      if ('categoryRef' in ref) return 'category-handle'
      if ('prompt' in ref) return 'human-prompt'
      return 'unknown' // TypeScript exhaustive check would catch this at compile time
    }

    const catHandle: DeferredOperand = {
      kind: 'deferred',
      ref: { categoryRef: 'h_xyz' },
    }
    const colRef: DeferredOperand = { kind: 'deferred', ref: { columnRef: 'other_field' } }
    const promptRef: DeferredOperand = { kind: 'deferred', ref: { prompt: 'Enter region' } }

    expect(classifyRef(catHandle)).toBe('category-handle')
    expect(classifyRef(colRef)).toBe('column')
    expect(classifyRef(promptRef)).toBe('human-prompt')

    console.log(
      '[API shape] FINDING: The property-presence union ({ columnRef } | { categoryRef } | { prompt })',
      'requires `in` narrowing — TypeScript handles it fine,',
      'but it is NOT a tagged union and JSON parsers must use key-presence checks.',
      'A tagged union ({ type: "column", fieldId } | { type: "category", handle } | { type: "prompt", text })',
      'would be safer to discriminate and extend.',
    )
  })

  test('API shape regret risk: null v in value operand is ambiguous', () => {
    // The spec says v is the value. But what if the real value IS null
    // (for IS NULL semantics)? The spec doesn't distinguish
    // "v: null (IS NULL filter)" from "v field missing entirely".
    // The validateCommand above checks for presence with `'v' in operand`
    // but a consumer checking `operand.v !== null` would reject valid IS NULL filters.

    const isNullFilter: SetInsightFilterCommand = {
      type: 'SetInsightFilter',
      insightId: 'insight-001',
      field: 'region',
      op: 'eq',
      operand: { kind: 'value', v: null },
    }

    const validation = validateCommand(isNullFilter)
    expect(validation.ok).toBe(true) // passes because we check 'in', not truthiness

    console.log(
      '[API shape] FINDING: v: null is semantically valid (IS NULL filter)',
      'but consumers checking `operand.v` (falsy) will incorrectly treat it as missing.',
      'The spec should explicitly state null is permitted and means IS NULL.',
    )
  })
})
