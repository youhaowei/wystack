import { describe, test, expect } from 'bun:test'
import { createSubscriptionManager } from '../subscriptions'

describe('SubscriptionManager', () => {
  test('add and get subscription', () => {
    const mgr = createSubscriptionManager()
    mgr.add({ id: 'sub1', functionPath: 'listTodos', args: {}, tablesWatched: new Set(['todos']) })
    expect(mgr.get('sub1')).toBeDefined()
    expect(mgr.get('sub1')!.functionPath).toBe('listTodos')
  })

  test('remove subscription', () => {
    const mgr = createSubscriptionManager()
    mgr.add({ id: 'sub1', functionPath: 'listTodos', args: {}, tablesWatched: new Set(['todos']) })
    mgr.remove('sub1')
    expect(mgr.get('sub1')).toBeUndefined()
  })

  test('getAffectedSubscriptions finds matching subs', () => {
    const mgr = createSubscriptionManager()
    mgr.add({ id: 'sub1', functionPath: 'listTodos', args: {}, tablesWatched: new Set(['todos']) })
    mgr.add({ id: 'sub2', functionPath: 'listUsers', args: {}, tablesWatched: new Set(['users']) })
    mgr.add({
      id: 'sub3',
      functionPath: 'listAll',
      args: {},
      tablesWatched: new Set(['todos', 'users']),
    })

    const affected = mgr.getAffectedSubscriptions(new Set(['todos']))
    expect(affected).toHaveLength(2)
    const ids = affected.map((s) => s.id).sort()
    expect(ids).toEqual(['sub1', 'sub3'])
  })

  test('getAffectedSubscriptions returns empty when no match', () => {
    const mgr = createSubscriptionManager()
    mgr.add({ id: 'sub1', functionPath: 'listTodos', args: {}, tablesWatched: new Set(['todos']) })
    const affected = mgr.getAffectedSubscriptions(new Set(['posts']))
    expect(affected).toHaveLength(0)
  })

  test('size and clear', () => {
    const mgr = createSubscriptionManager()
    mgr.add({ id: 'sub1', functionPath: 'a', args: {}, tablesWatched: new Set() })
    mgr.add({ id: 'sub2', functionPath: 'b', args: {}, tablesWatched: new Set() })
    expect(mgr.size()).toBe(2)
    mgr.clear()
    expect(mgr.size()).toBe(0)
  })
})
