import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { defineSchema, int, syncSchema, table, text } from '@wystack/db'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/pglite'
import {
  createDraftLifecycle,
  DEFAULT_OWNED_DRAFT_PAGE_SIZE,
  MAX_DRAFT_SUMMARY_BYTES,
  MAX_DRAFT_SUMMARY_DEPTH,
  MAX_OWNED_DRAFT_PAGE_SIZE,
  type DraftSummary,
} from '../draft-lifecycle'
import { defineApp } from '../define-app'

const schema = defineSchema({
  todos: table({ id: int.primaryKey(), title: text }).draftable(),
})
const wy = defineApp<Record<string, unknown>>({ permissions: {} })
let pg: PGlite
let db: ReturnType<typeof drizzle>
let app: Awaited<ReturnType<typeof wy.build>>

function lifecycle() {
  return createDraftLifecycle(app, {
    resolveOwner: (context) => context['owner'] ?? 'test-owner',
    authorizeGlobalDraft: () => true,
  })
}

function nestedSummary(depth: number): DraftSummary {
  let summary: DraftSummary = 'leaf'
  for (let current = 0; current < depth; current += 1) summary = { child: summary }
  return summary
}

function summaryAtSerializedByteLimit(): string {
  const payloadBytes = MAX_DRAFT_SUMMARY_BYTES - 2
  return '界'.repeat(Math.floor(payloadBytes / 3)) + 'x'.repeat(payloadBytes % 3)
}

async function readDraftArtifactCounts() {
  const persisted = await db.execute(`SELECT
    (SELECT count(*) FROM wystack_drafts) AS drafts,
    (SELECT count(*) FROM wystack_draft_commands) AS commands,
    (SELECT count(*) FROM wystack_draft_tables) AS tables,
    (SELECT count(*) FROM wystack_draft_row_changes) AS changes`)
  const row = (persisted as { rows: Array<Record<string, unknown>> }).rows[0]
  return {
    drafts: Number(row?.['drafts']),
    commands: Number(row?.['commands']),
    tables: Number(row?.['tables']),
    changes: Number(row?.['changes']),
  }
}

beforeEach(async () => {
  pg = new PGlite()
  db = drizzle(pg)
  await syncSchema(db, schema)
  app = await wy.build({
    db,
    functions: {
      addTodo: wy.procedure
        .input({ id: int, title: text })
        .command(async (ctx, args) => ctx.db.into(schema.todos).insert(args)),
      boom: wy.procedure.input({}).command(async () => {
        throw new Error('command boom')
      }),
      mustNotRun: wy.procedure.input({}).command(async () => {
        throw new Error('losing command batch executed')
      }),
    },
  })
})

afterEach(async () => {
  await pg.close()
})

describe('draft lifecycle — owned discovery and atomic creation', () => {
  test('opens a discoverable, materialized initial command batch in one operation', async () => {
    const drafts = lifecycle()
    const command = {
      id: 'initial-command',
      path: 'addTodo',
      args: { id: 3, title: 'atomic cherry' },
    }

    const { draftId, results } = await drafts.openWithCommands(0, [command], {
      lookupKey: 'artifact:atomic-success',
      summary: { title: 'Atomic draft', commandCount: 1 },
    })

    expect(results.map((result) => result.id)).toEqual(['initial-command'])
    expect(await drafts.getLog(draftId)).toEqual([command])
    expect(await drafts.inspect(draftId)).toContainEqual(
      expect.objectContaining({ draftId, table: 'todos', operation: 'insert' }),
    )
    expect(await drafts.findOwnedByLookupKey('artifact:atomic-success')).toMatchObject({
      draftId,
      summary: { title: 'Atomic draft', commandCount: 1 },
    })
  })

  test('rolls back a failed atomic open before the draft becomes discoverable', async () => {
    const drafts = lifecycle()

    await expect(
      drafts.openWithCommands(
        0,
        [
          { path: 'addTodo', args: { id: 3, title: 'must roll back' } },
          { path: 'boom', args: {} },
        ],
        {
          lookupKey: 'artifact:atomic-failure',
          summary: { title: 'Must not survive' },
        },
      ),
    ).rejects.toThrow('command boom')

    expect(await drafts.findOwnedByLookupKey('artifact:atomic-failure')).toBeUndefined()
    expect(await drafts.listOwned()).toEqual([])
    expect(await readDraftArtifactCounts()).toEqual({
      drafts: 0,
      commands: 0,
      tables: 0,
      changes: 0,
    })
  })

  test('rejects an empty atomic-open batch without creating a draft', async () => {
    const drafts = lifecycle()

    await expect(drafts.openWithCommands(0, [])).rejects.toThrow('non-empty batch')
    expect(await drafts.listOwned()).toEqual([])
  })

  test('get-or-open never executes the losing command batch', async () => {
    const drafts = lifecycle()
    const lookupKey = 'artifact:existing-draft'
    const first = await drafts.getOrOpenWithCommands(
      0,
      [{ id: 'first', path: 'addTodo', args: { id: 3, title: 'created' } }],
      { lookupKey },
    )

    // This handler throws if dispatched, so the successful result proves the
    // existing-key branch returns before executing the losing batch.
    const second = await drafts.getOrOpenWithCommands(
      0,
      [{ id: 'second', path: 'mustNotRun', args: {} }],
      { lookupKey },
    )

    expect({ created: first.created, resultIds: first.results.map(({ id }) => id) }).toEqual({
      created: true,
      resultIds: ['first'],
    })
    expect(second).toEqual({ created: false, draftId: first.draftId, results: [] })
    expect(await drafts.getLog(first.draftId)).toEqual([
      { id: 'first', path: 'addTodo', args: { id: 3, title: 'created' } },
    ])
  })

  test('lists stable created-order pages after lifecycle recreation', async () => {
    const drafts = lifecycle()
    const aliceOldest = await drafts.open({ sequence: 1 }, { context: { owner: 'alice' } })
    const bob = await drafts.open({ sequence: 2 }, { context: { owner: 'bob' } })
    const aliceTieA = await drafts.open({ sequence: 3 }, { context: { owner: 'alice' } })
    const aliceTieB = await drafts.open({ sequence: 4 }, { context: { owner: 'alice' } })
    const aliceNewest = await drafts.open({ sequence: 5 }, { context: { owner: 'alice' } })

    await db.execute(sql`UPDATE wystack_drafts SET created_at =
      CASE draft_id
        WHEN ${aliceOldest} THEN '2026-08-01T00:00:00.000Z'::timestamptz
        WHEN ${bob} THEN '2026-08-02T00:00:00.000Z'::timestamptz
        WHEN ${aliceTieA} THEN '2026-08-03T00:00:00.000Z'::timestamptz
        WHEN ${aliceTieB} THEN '2026-08-03T00:00:00.000Z'::timestamptz
        WHEN ${aliceNewest} THEN '2026-08-04T00:00:00.000Z'::timestamptz
        ELSE updated_at
      END`)

    const restarted = lifecycle()
    const tieOrder = [aliceTieA, aliceTieB].sort().reverse()
    const firstPage = await restarted.listOwned({ context: { owner: 'alice' }, limit: 2 })
    await restarted.append(
      aliceOldest,
      [{ path: 'addTodo', args: { id: 90, title: 'moves updated_at only' } }],
      { context: { owner: 'alice' }, summary: { title: 'oldest changed' } },
    )
    const secondPage = await restarted.listOwned({
      context: { owner: 'alice' },
      limit: 2,
      cursor: firstPage.at(-1)?.cursor,
    })

    expect([...firstPage, ...secondPage].map((draft) => draft.draftId)).toEqual([
      aliceNewest,
      ...tieOrder,
      aliceOldest,
    ])
    expect(firstPage[0]?.cursor.draftId).toBe(aliceNewest)
    expect(firstPage[0]?.cursor.createdAt).toBe(firstPage[0]?.createdAt)
    expect(firstPage[0]?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
  })

  test('applies safe default and maximum owner-list page bounds', async () => {
    const drafts = lifecycle()
    for (let sequence = 0; sequence <= DEFAULT_OWNED_DRAFT_PAGE_SIZE; sequence += 1) {
      await drafts.open({ sequence }, { context: { owner: 'alice' } })
    }

    expect(await drafts.listOwned({ context: { owner: 'alice' } })).toHaveLength(
      DEFAULT_OWNED_DRAFT_PAGE_SIZE,
    )
    await expect(
      drafts.listOwned({
        context: { owner: 'alice' },
        limit: MAX_OWNED_DRAFT_PAGE_SIZE + 1,
      }),
    ).rejects.toThrow(`must not exceed ${MAX_OWNED_DRAFT_PAGE_SIZE}`)
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      await expect(drafts.listOwned({ context: { owner: 'alice' }, limit })).rejects.toThrow(
        'positive safe integer',
      )
    }
  })

  test('persists snapshotted lookup metadata across append and lifecycle recreation', async () => {
    const drafts = lifecycle()
    const initialSummary = { title: 'initial', nested: { sequence: 1 } }
    const opening = drafts.open(0, {
      context: { owner: 'alice' },
      lookupKey: 'artifact:file-1',
      summary: initialSummary,
    })
    initialSummary.title = 'mutated after open'
    const draftId = await opening
    expect(
      await drafts.findOwnedByLookupKey('artifact:file-1', {
        context: { owner: 'alice' },
      }),
    ).toMatchObject({ summary: { title: 'initial', nested: { sequence: 1 } } })

    const nextSummary = { title: 'after append', nested: { sequence: 2 } }
    const appending = drafts.append(
      draftId,
      [{ path: 'addTodo', args: { id: 91, title: 'metadata' } }],
      { context: { owner: 'alice' }, summary: nextSummary },
    )
    nextSummary.nested.sequence = 999
    await appending

    expect(
      await lifecycle().findOwnedByLookupKey('artifact:file-1', {
        context: { owner: 'alice' },
      }),
    ).toMatchObject({
      draftId,
      lookupKey: 'artifact:file-1',
      summary: { title: 'after append', nested: { sequence: 2 } },
    })
  })

  test('rolls a failed append summary replacement back with its command batch', async () => {
    const drafts = lifecycle()
    const context = { owner: 'alice' }
    const draftId = await drafts.open(0, {
      context,
      lookupKey: 'artifact:file-2',
      summary: { state: 'initial' },
    })

    await expect(
      drafts.append(
        draftId,
        [
          { path: 'addTodo', args: { id: 92, title: 'rolled back' } },
          { path: 'boom', args: {} },
        ],
        { context, summary: { state: 'must-not-commit' } },
      ),
    ).rejects.toThrow('command boom')
    expect(await drafts.findOwnedByLookupKey('artifact:file-2', { context })).toMatchObject({
      summary: { state: 'initial' },
    })
  })

  test('preserves an omitted append summary and clears an explicit null', async () => {
    const drafts = lifecycle()
    const context = { owner: 'alice' }
    const draftId = await drafts.open(0, {
      context,
      lookupKey: 'artifact:file-3',
      summary: { state: 'initial' },
    })

    await drafts.append(draftId, [{ path: 'addTodo', args: { id: 93, title: 'keeps summary' } }], {
      context,
    })
    expect(await drafts.findOwnedByLookupKey('artifact:file-3', { context })).toMatchObject({
      summary: { state: 'initial' },
    })

    await drafts.append(draftId, [], { context, summary: null })
    expect(await drafts.findOwnedByLookupKey('artifact:file-3', { context })).toMatchObject({
      summary: null,
    })
  })

  test('validates lookup keys at open and discovery entrypoints', async () => {
    const drafts = lifecycle()
    await expect(
      drafts.open(0, {
        context: { owner: 'alice' },
        lookupKey: '界'.repeat(171),
      }),
    ).rejects.toThrow('512 UTF-8 bytes')
    await expect(drafts.findOwnedByLookupKey('', { context: { owner: 'alice' } })).rejects.toThrow(
      'non-empty text',
    )
    expect(await drafts.listOwned({ context: { owner: 'alice' } })).toEqual([])
  })

  test('bounds multibyte summaries by serialized UTF-8 size at every open ingress', async () => {
    const drafts = lifecycle()
    const exactLimit = summaryAtSerializedByteLimit()
    const oversized = `${exactLimit}界`
    expect(new TextEncoder().encode(JSON.stringify(exactLimit)).byteLength).toBe(
      MAX_DRAFT_SUMMARY_BYTES,
    )
    const acceptedId = await drafts.open(0, {
      lookupKey: 'summary:exact-limit',
      summary: exactLimit,
    })

    await expect(drafts.open(0, { summary: oversized })).rejects.toThrow(
      `${MAX_DRAFT_SUMMARY_BYTES} serialized UTF-8 bytes`,
    )
    await expect(
      drafts.openWithCommands(0, [{ path: 'mustNotRun', args: {} }], {
        lookupKey: 'summary:oversized-atomic',
        summary: oversized,
      }),
    ).rejects.toThrow(`${MAX_DRAFT_SUMMARY_BYTES} serialized UTF-8 bytes`)
    await expect(
      drafts.getOrOpenWithCommands(0, [{ path: 'mustNotRun', args: {} }], {
        lookupKey: 'summary:oversized-get-or-open',
        summary: oversized,
      }),
    ).rejects.toThrow(`${MAX_DRAFT_SUMMARY_BYTES} serialized UTF-8 bytes`)

    expect(await drafts.findOwnedByLookupKey('summary:exact-limit')).toMatchObject({
      draftId: acceptedId,
      summary: exactLimit,
    })
    expect(await drafts.findOwnedByLookupKey('summary:oversized-atomic')).toBeUndefined()
    expect(await drafts.findOwnedByLookupKey('summary:oversized-get-or-open')).toBeUndefined()
  })

  test('rejects over-deep replacements before append command execution or fork writes', async () => {
    const drafts = lifecycle()
    const sourceId = await drafts.open(0, {
      lookupKey: 'summary:depth-source',
      summary: { state: 'initial' },
    })
    const exactDepth = nestedSummary(MAX_DRAFT_SUMMARY_DEPTH)
    const exactDepthId = await drafts.open(0, { summary: exactDepth })
    const overDepth: DraftSummary = { child: exactDepth }

    await expect(
      drafts.append(sourceId, [{ path: 'mustNotRun', args: {} }], { summary: overDepth }),
    ).rejects.toThrow(`${MAX_DRAFT_SUMMARY_DEPTH} nested containers`)
    await expect(
      drafts.forkAndDiscard(sourceId, 1, (commands) => ({ commands, summary: overDepth })),
    ).rejects.toThrow(`${MAX_DRAFT_SUMMARY_DEPTH} nested containers`)

    expect(await drafts.findOwnedByLookupKey('summary:depth-source')).toMatchObject({
      draftId: sourceId,
      summary: { state: 'initial' },
    })
    expect((await drafts.listOwned()).map((draft) => draft.draftId)).toContain(exactDepthId)
  })

  test('default custody follows stable principal identity, not mutable profile fields', async () => {
    const drafts = createDraftLifecycle(app, { authorizeGlobalDraft: () => true })
    const draftId = await drafts.open(0, {
      context: {
        principal: {
          kind: 'user',
          userId: 'user-1',
          identity: { subject: 'provider|1', email: 'old@example.test' },
        },
      },
    })

    expect(
      await createDraftLifecycle(app, { authorizeGlobalDraft: () => true }).getLog(draftId, {
        context: {
          principal: {
            kind: 'user',
            userId: 'user-1',
            identity: { subject: 'provider|1', email: 'new@example.test' },
          },
        },
      }),
    ).toEqual([])

    const persisted = await db.execute(
      `SELECT owner_key FROM wystack_drafts WHERE draft_id = '${draftId}'`,
    )
    const ownerKey = (persisted as { rows: Array<{ owner_key: unknown }> }).rows[0]?.owner_key
    expect(JSON.stringify(ownerKey)).not.toContain('old@example.test')
  })
})
