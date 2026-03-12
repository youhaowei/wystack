import { describe, test, expect } from 'bun:test'
import { eq, ne, gt, gte, lt, lte } from '../operators'

describe('Filter operators', () => {
  test('eq produces correct descriptor', () => {
    const f = eq('name', 'Alice')
    expect(f).toEqual({ op: 'eq', column: 'name', value: 'Alice' })
  })

  test('ne produces correct descriptor', () => {
    const f = ne('status', 'deleted')
    expect(f).toEqual({ op: 'ne', column: 'status', value: 'deleted' })
  })

  test('gt produces correct descriptor', () => {
    const f = gt('age', 18)
    expect(f).toEqual({ op: 'gt', column: 'age', value: 18 })
  })

  test('gte produces correct descriptor', () => {
    const f = gte('score', 100)
    expect(f).toEqual({ op: 'gte', column: 'score', value: 100 })
  })

  test('lt produces correct descriptor', () => {
    const f = lt('price', 50)
    expect(f).toEqual({ op: 'lt', column: 'price', value: 50 })
  })

  test('lte produces correct descriptor', () => {
    const f = lte('count', 0)
    expect(f).toEqual({ op: 'lte', column: 'count', value: 0 })
  })
})
