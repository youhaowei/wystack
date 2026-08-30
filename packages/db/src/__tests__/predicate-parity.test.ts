import { describe, expect, test } from 'bun:test'
import { and, eq, inArray, isNotNull, isNull, lt, notInArray, or } from '../operators'
import { predicateParityScenario } from './predicate-parity.fixture'

describe('canonical and draft predicate parity', () => {
  const scenario = predicateParityScenario()

  test('preserves nested AND/OR grouping after rows enter and leave the predicate', async () => {
    const predicate = and(or(eq('status', 'blocked'), eq('status', 'ready')), lt('score', 55))

    const { effective, canonical } = await scenario.rowsMatching(predicate)

    expect(effective).toEqual(canonical)
    expect(effective.map(({ id }) => id)).toEqual([1, 5])
  })

  test('matches dynamic membership against effective values and draft inserts', async () => {
    const predicate = and(inArray('status', ['ready', 'blocked']), notInArray('id', [1, 7]))

    const { effective, canonical } = await scenario.rowsMatching(predicate)

    expect(effective).toEqual(canonical)
    expect(effective.map(({ id }) => id)).toEqual([5, 6])
  })

  test('matches explicit null predicates after draft nulling, filling, and deletion', async () => {
    const { effective, canonical } = await scenario.rowsMatching(
      and(isNull('owner'), isNotNull('title')),
    )

    expect(effective).toEqual(canonical)
    expect(effective.map(({ id }) => id)).toEqual([1, 6])
  })

  test('uses the set identities for empty membership lists', async () => {
    const empty = await scenario.rowsMatching(inArray('status', []))
    const unrestricted = await scenario.rowsMatching(notInArray('status', []))

    expect(empty.effective).toEqual(empty.canonical)
    expect(empty.effective).toEqual([])
    expect(unrestricted.effective).toEqual(unrestricted.canonical)
    expect(unrestricted.effective.map(({ id }) => id)).toEqual([1, 2, 3, 5, 6, 7])
  })

  test('updates the same effective rows selected by a composed predicate', async () => {
    const result = await scenario.updateMatching(
      and(inArray('status', ['blocked', 'ready']), isNull('owner')),
      { score: 99 },
    )

    expect(result.effectiveReturnedIds).toEqual(result.canonicalReturnedIds)
    expect(result.effectiveReturnedIds).toEqual([1, 6])
    expect(result.rows.effective).toEqual(result.rows.canonical)
  })

  test('deletes the same effective rows selected by a composed predicate', async () => {
    const result = await scenario.deleteMatching(
      or(and(notInArray('status', ['archived', 'ready']), isNotNull('owner')), isNull('owner')),
    )

    expect(result.effectiveReturnedIds).toEqual(result.canonicalReturnedIds)
    expect(result.effectiveReturnedIds).toEqual([1, 6, 7])
    expect(result.rows.effective).toEqual(result.rows.canonical)
    expect(result.rows.effective.map(({ id }) => id)).toEqual([2, 3, 5])
  })
})
