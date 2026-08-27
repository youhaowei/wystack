import { describe, expect, test } from 'bun:test'
import { eq, gt, gte, lt, lte, ne, type FilterDescriptor } from '../operators'
import { boundedDraftPlan, boundedDraftScenario } from './draft-bounded-sql.fixture'

const plan = boundedDraftPlan()

const canonicalFilterExamples: Array<{
  behavior: string
  contract: string
  filter: FilterDescriptor
  direction: 'asc' | 'desc'
  limit: number
}> = [
  {
    behavior: 'greater-than',
    contract: 'includes rows promoted or inserted above 50',
    filter: gt('score', 50),
    direction: 'desc',
    limit: 6,
  },
  {
    behavior: 'greater-than-or-equal',
    contract: 'includes the row promoted from 40 to 95',
    filter: gte('score', 40),
    direction: 'asc',
    limit: 8,
  },
  {
    behavior: 'less-than',
    contract: 'includes the row demoted from 100 to 5',
    filter: lt('score', 90),
    direction: 'desc',
    limit: 8,
  },
  {
    behavior: 'less-than-or-equal',
    contract: 'includes the row demoted below 80',
    filter: lte('score', 80),
    direction: 'asc',
    limit: 8,
  },
  {
    behavior: 'not-equal',
    contract: 'applies after draft inserts, updates, and deletes',
    filter: ne('score', 70),
    direction: 'desc',
    limit: 8,
  },
  {
    behavior: 'equality',
    contract: 'finds the row promoted to exactly 95',
    filter: eq('score', 95),
    direction: 'asc',
    limit: 1,
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
    })
  }

  /**
   * Given a draft that promotes row 7, inserts row 9, demotes row 1, and deletes
   * row 2, the three highest effective scores must be 95, 85, and 80.
   */
  test('refills the bounded result after draft changes', async () => {
    const rows = await scenario
      .draftItems()
      .where(gte('score', 50))
      .orderBy('score', 'desc')
      .limit(3)
      .all()

    expect(rows.map(({ id, score }) => [id, score])).toEqual([
      [7, 95],
      [9, 85],
      [3, 80],
    ])
  })

  /**
   * `first()` is a bounded read too. It must select the same effective row as a
   * canonical table where the draft changes have already been applied.
   */
  test('returns the canonical winner from first()', async () => {
    const { effective, canonical } = await scenario.readBoth((items) =>
      items.where(gte('score', 50)).orderBy('score', 'desc').first(),
    )

    expect(effective).toEqual(canonical)
  })

  /**
   * A zero limit is a real bound, not an absent limit. No canonical or draft row
   * may escape it.
   */
  test('returns no rows for limit zero', async () => {
    const rows = await scenario.draftItems().where(gte('score', 50)).limit(0).all()
    const first = await scenario.draftItems().where(gte('score', 50)).limit(0).first()

    expect(rows).toEqual([])
    expect(first).toBeNull()
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
  })

  /**
   * Explicitly setting a draft field to null must participate in PostgreSQL's
   * normal null ordering, including when only the ordered fields are projected.
   */
  test('preserves null ordering through a projection', async () => {
    const { effective, canonical } = await scenario.readBoth((items) =>
      items.select('id', 'note').orderBy('note', 'desc').limit(4).all(),
    )

    expect(effective).toEqual(canonical)
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
