/**
 * Tests for the bounded + compacted command log (YW-121).
 *
 * `compactLog` collapses runs that share a `compactionKey` to NET EFFECT:
 *   - create then delete (same key)        → both removed (never existed)
 *   - create/update then update (same key) → the LATER kept
 *   - keyless commands                     → never compacted, order preserved
 *
 * The key is OPAQUE (the app mints it, e.g. `${path}:${args.id}`); compaction is
 * artifact-agnostic.
 */
import { describe, test, expect } from 'bun:test'
import { compactLog, type DraftCommand } from '../draft-lifecycle'

describe('compactLog — net-effect collapse', () => {
  test('add then delete (same key) cancels both', () => {
    const log: DraftCommand[] = [
      { path: 'addTodo', args: { id: 3 }, compactionKey: 'todo:3', kind: 'create' },
      { path: 'removeTodo', args: { id: 3 }, compactionKey: 'todo:3', kind: 'delete' },
    ]
    expect(compactLog(log)).toEqual([])
  })

  test('add then tweak then delete collapses to nothing', () => {
    const log: DraftCommand[] = [
      { path: 'addTodo', args: { id: 3, title: 'a' }, compactionKey: 'todo:3', kind: 'create' },
      { path: 'renameTodo', args: { id: 3, title: 'b' }, compactionKey: 'todo:3', kind: 'update' },
      { path: 'removeTodo', args: { id: 3 }, compactionKey: 'todo:3', kind: 'delete' },
    ]
    expect(compactLog(log)).toEqual([])
  })

  test('update then update (same key) keeps the later, at the later position', () => {
    const log: DraftCommand[] = [
      { path: 'renameTodo', args: { id: 1, title: 'a' }, compactionKey: 'todo:1', kind: 'update' },
      { path: 'renameTodo', args: { id: 1, title: 'b' }, compactionKey: 'todo:1', kind: 'update' },
    ]
    const out = compactLog(log)
    expect(out).toHaveLength(1)
    expect((out[0].args as { title: string }).title).toBe('b')
  })

  test('survivor is emitted at the key LAST occurrence, not its first (replay order)', () => {
    // Interleaved keys: X is edited, then Y, then X again. The X survivor must
    // land at X's LAST position (after Y), because publish replays in order and
    // the client-id invariant (a create precedes its referrer) rides on it.
    // A first-occurrence emit would (wrongly) yield [X_v2, Y].
    const log: DraftCommand[] = [
      { path: 'renameTodo', args: { id: 1, title: 'X1' }, compactionKey: 'todo:1', kind: 'update' },
      { path: 'renameTodo', args: { id: 2, title: 'Y' }, compactionKey: 'todo:2', kind: 'update' },
      { path: 'renameTodo', args: { id: 1, title: 'X2' }, compactionKey: 'todo:1', kind: 'update' },
    ]
    const out = compactLog(log)
    expect(out.map((c) => (c.args as { title: string }).title)).toEqual(['Y', 'X2'])
  })

  test('a repeated command object reference is emitted at most once per surviving role', () => {
    // compactLog is exported/public; a caller could hand it an array where the
    // SAME object reference appears twice. Position-based (not identity-based)
    // survivor tracking must still emit the key exactly once.
    const dup: DraftCommand = {
      path: 'renameTodo',
      args: { id: 1, title: 'x' },
      compactionKey: 'todo:1',
      kind: 'update',
    }
    const out = compactLog([dup, dup])
    expect(out).toHaveLength(1)
  })

  test('keyless commands are never compacted and keep their order', () => {
    const log: DraftCommand[] = [
      { path: 'sideEffectA', args: {} },
      { path: 'sideEffectB', args: {} },
      { path: 'sideEffectA', args: {} },
    ]
    expect(compactLog(log)).toEqual(log)
  })

  test('distinct keys are independent; a delete-of-create cancels only its own key', () => {
    const log: DraftCommand[] = [
      { path: 'addTodo', args: { id: 1 }, compactionKey: 'todo:1', kind: 'create' },
      { path: 'addTodo', args: { id: 2 }, compactionKey: 'todo:2', kind: 'create' },
      { path: 'removeTodo', args: { id: 1 }, compactionKey: 'todo:1', kind: 'delete' },
    ]
    const out = compactLog(log)
    expect(out.map((c) => c.compactionKey)).toEqual(['todo:2'])
  })

  test('a delete of a row NOT created in this draft is kept (it deletes canonical)', () => {
    const log: DraftCommand[] = [
      { path: 'removeTodo', args: { id: 9 }, compactionKey: 'todo:9', kind: 'delete' },
    ]
    expect(compactLog(log)).toEqual(log)
  })

  test('create + update keeps BOTH (create then update) so publish inserts then edits', () => {
    // A create followed by an update of the SAME key must NOT collapse to the
    // update alone — that update would UPDATE a row that does not exist in
    // canonical yet, silently dropping the created item. Keep the create + the
    // last update, in order.
    const log: DraftCommand[] = [
      { path: 'addTodo', args: { id: 1, title: 'a' }, compactionKey: 'todo:1', kind: 'create' },
      { path: 'renameTodo', args: { id: 1, title: 'b' }, compactionKey: 'todo:1', kind: 'update' },
      { path: 'renameTodo', args: { id: 1, title: 'c' }, compactionKey: 'todo:1', kind: 'update' },
    ]
    const out = compactLog(log)
    expect(out.map((c) => c.kind)).toEqual(['create', 'update'])
    expect((out[1].args as { title: string }).title).toBe('c') // last update wins
  })

  test('delete of a canonical row supersedes prior updates of the same key', () => {
    const log: DraftCommand[] = [
      { path: 'renameTodo', args: { id: 9, title: 'x' }, compactionKey: 'todo:9', kind: 'update' },
      { path: 'removeTodo', args: { id: 9 }, compactionKey: 'todo:9', kind: 'delete' },
    ]
    expect(compactLog(log).map((c) => c.kind)).toEqual(['delete'])
  })

  test('create → delete → create REOPENS the key (the second create survives)', () => {
    const log: DraftCommand[] = [
      { path: 'addTodo', args: { id: 1, title: 'a' }, compactionKey: 'todo:1', kind: 'create' },
      { path: 'removeTodo', args: { id: 1 }, compactionKey: 'todo:1', kind: 'delete' },
      { path: 'addTodo', args: { id: 1, title: 'b' }, compactionKey: 'todo:1', kind: 'create' },
    ]
    const out = compactLog(log)
    expect(out).toHaveLength(1)
    expect((out[0].args as { title: string }).title).toBe('b')
  })
})
