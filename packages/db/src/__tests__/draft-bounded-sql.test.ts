import { describe, expect, test } from 'bun:test'
import { eq, gt, gte, lt, lte, ne, type FilterDescriptor } from '../operators'
import {
  boundedDraftPlan,
  boundedDraftScenario,
  useBoundedDraftHarness,
} from './draft-bounded-sql.fixture'

useBoundedDraftHarness()

const plan = boundedDraftPlan()

const canonicalFilterExamples: Array<{
  behavior: string
  contract: string
  filter: FilterDescriptor
  direction: 'asc' | 'desc'
  limit: number
  expectedIds?: number[]
}> = [
  {
    behavior: 'greater-than',
    contract: 'includes rows promoted or inserted above 100',
    filter: gt('score', 100),
    direction: 'desc',
    limit: 6,
  },
  {
    behavior: 'greater-than-or-equal',
    contract: 'preserves the tied lower boundary at 60',
    filter: gte('score', 60),
    direction: 'asc',
    limit: 8,
  },
  {
    behavior: 'less-than',
    contract: 'includes rows demoted below 100',
    filter: lt('score', 100),
    direction: 'asc',
    limit: 8,
    expectedIds: [1, 10, 122, 117, 115, 116, 113, 114],
  },
  {
    behavior: 'less-than-or-equal',
    contract: 'keeps the lower boundary after moves and deletes',
    filter: lte('score', 80),
    direction: 'asc',
    limit: 8,
  },
  {
    behavior: 'not-equal',
    contract: 'excludes both rows promoted to 130',
    filter: ne('score', 130),
    direction: 'desc',
    limit: 8,
    expectedIds: [121, 3, 4, 5, 6, 7, 8, 9],
  },
  {
    behavior: 'equality',
    contract: 'finds both rows promoted to the same score',
    filter: eq('score', 130),
    direction: 'asc',
    limit: 2,
  },
]

describe('bounded SQL plan choice', () => {
  /**
   * Every plan returns the same rows, so result parity below cannot tell them
   * apart. What it cannot observe is how much canonical data a read scans: a
   * filtered or limited read must take the bounded L + M candidate plan, and
   * only an unfiltered, unlimited read may fall back to the exact full overlay.
   */
  test('filtered or limited reads are bounded; unfiltered reads use the exact overlay', () => {
    expect(
      plan.draftItems().where(gte('score', 50)).orderBy('score', 'desc').limit(3).toSql().plan,
    ).toBe('bounded')
    expect(plan.draftItems().where(gte('score', 50)).toSql().plan).toBe('bounded')
    expect(plan.draftItems().limit(3).toSql().plan).toBe('bounded')
    expect(plan.draftItems().toSql().plan).toBe('overlay')
  })
})

describe('bounded SQL result parity', () => {
  const scenario = boundedDraftScenario()

  /**
   * Keep this as a fixture invariant. With 120 effective rows, eight draft
   * changes, and a maximum result limit of eight, the bounded plan's L + M
   * prefix is materially smaller than the canonical table. A tiny fixture can
   * produce correct results while never exercising candidate pruning at all.
   */
  test('the fixture makes the bounded candidate prefix smaller than the table', async () => {
    const { canonicalRows, draftChanges } = await scenario.pruningDimensions()

    expect(canonicalRows).toBeGreaterThan(8 + draftChanges)
  })

  /**
   * Every canonical comparison operator must mean the same thing after the
   * draft overlay. Each named example crosses a draft boundary and compares the
   * effective read with independently materialized canonical data.
   */
  for (const example of canonicalFilterExamples) {
    test(`${example.behavior}: ${example.contract}`, async () => {
      const { effective, canonical } = await scenario.readBoth((items) =>
        items.where(example.filter).orderBy('score', example.direction).limit(example.limit).all(),
      )

      expect(effective).toEqual(canonical)
      if (example.expectedIds) {
        expect(effective.map((row) => row.id)).toEqual(example.expectedIds)
      }
    })
  }

  const boundaryExamples = [
    {
      direction: 'desc' as const,
      expected: [119, 120, 121, 3],
      contract: 'promotions and an insert enter after the original leaders move or are deleted',
    },
    {
      direction: 'asc' as const,
      expected: [1, 10, 122, 117],
      contract: 'demotions and an insert enter after the original trailers move or are deleted',
    },
  ]

  for (const example of boundaryExamples) {
    test(`${example.direction}: ${example.contract}`, async () => {
      const { effective, canonical } = await scenario.readBoth((items) =>
        items.orderBy('score', example.direction).limit(4).all(),
      )

      expect(effective).toEqual(canonical)
      expect(effective.map((row) => row.id)).toEqual(example.expected)
    })
  }

  /**
   * `first()` is a bounded read too. It must select the same effective row as a
   * canonical table where the draft changes have already been applied.
   */
  test('returns the canonical winner from first()', async () => {
    const { effective, canonical } = await scenario.readBoth((items) =>
      items.where(gte('score', 100)).orderBy('score', 'desc').first(),
    )

    expect(effective).toEqual(canonical)
    expect(effective?.id).toBe(119)
  })

  /**
   * A zero limit is a real bound, not an absent limit. No canonical or draft row
   * may escape it.
   */
  test('returns no rows for limit zero', async () => {
    const rows = await scenario.readBoth((items) => items.where(gte('score', 50)).limit(0).all())
    const first = await scenario.readBoth((items) => items.where(gte('score', 50)).limit(0).first())

    expect(rows.effective).toEqual(rows.canonical)
    expect(rows.effective).toEqual([])
    expect(first.effective).toEqual(first.canonical)
    expect(first.effective).toBeNull()
  })

  /**
   * Projection must not change PostgreSQL text ordering. A draft title update
   * that sorts first must produce the same projected prefix as canonical data.
   */
  test('preserves text ordering through a projection', async () => {
    const { effective, canonical } = await scenario.readBoth((items) =>
      items.select('id', 'title').orderBy('title', 'asc').limit(3).all(),
    )

    expect(effective).toEqual(canonical)
    expect(effective.map((row) => row.id)).toEqual([10, 119, 120])
  })

  /**
   * Explicitly setting a draft field to null must participate in PostgreSQL's
   * normal null ordering, including when only the ordered fields are projected.
   */
  test('preserves null ordering through a projection', async () => {
    const { effective, canonical } = await scenario.readBoth((items) =>
      items.select('id', 'note').orderBy('note', 'desc').limit(5).all(),
    )

    expect(effective).toEqual(canonical)
    expect(effective.map((row) => row.id)).toEqual([1, 3, 100, 119, 121])
  })
})

describe('bounded SQL tenant isolation', () => {
  const scenario = boundedDraftScenario()

  /**
   * Alpha and beta deliberately reuse one draft ID. Each tenant must still see
   * only its own canonical candidates and its own promoted row.
   */
  test('scopes a shared draft ID to its tenant', async () => {
    const tenants = await scenario.sharedDraftAcrossTwoTenants()

    const alphaRows = await tenants
      .alphaItems()
      .where(gte('score', 0))
      .orderBy('score', 'desc')
      .limit(2)
      .all()
    const betaRows = await tenants
      .betaItems()
      .where(gte('score', 0))
      .orderBy('score', 'desc')
      .limit(2)
      .all()

    expect(alphaRows.map(({ title, score }) => [title, score])).toEqual([
      ['alpha one', 30],
      ['alpha two', 20],
    ])
    expect(betaRows.map(({ title, score }) => [title, score])).toEqual([
      ['beta one', 300],
      ['beta two', 200],
    ])
  })
})
