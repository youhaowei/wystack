/**
 * Tests for conservative command-log compaction.
 *
 * `compactLog` collapses runs that share a `compactionKey` to NET EFFECT:
 *   - create then delete (same key)        → both removed (never existed)
 *   - update then update (same key)        → BOTH kept in replay order
 *   - delete of a CANONICAL row then create → BOTH kept, in order (a replace)
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

  test('two updates stay ordered because an opaque key cannot prove they are mergeable', () => {
    const log: DraftCommand[] = [
      { path: 'renameTodo', args: { id: 1, title: 'a' }, compactionKey: 'todo:1', kind: 'update' },
      { path: 'renameTodo', args: { id: 1, title: 'b' }, compactionKey: 'todo:1', kind: 'update' },
    ]
    const out = compactLog(log)
    expect(out.map((command) => (command.args as { title: string }).title)).toEqual(['a', 'b'])
  })

  test('updates on interleaved keys keep their original replay order', () => {
    const log: DraftCommand[] = [
      { path: 'renameTodo', args: { id: 1, title: 'X1' }, compactionKey: 'todo:1', kind: 'update' },
      { path: 'renameTodo', args: { id: 2, title: 'Y' }, compactionKey: 'todo:2', kind: 'update' },
      { path: 'renameTodo', args: { id: 1, title: 'X2' }, compactionKey: 'todo:1', kind: 'update' },
    ]
    const out = compactLog(log)
    expect(out.map((c) => (c.args as { title: string }).title)).toEqual(['X1', 'Y', 'X2'])
  })

  test('a repeated object reference still represents two ordered updates', () => {
    const dup: DraftCommand = {
      path: 'renameTodo',
      args: { id: 1, title: 'x' },
      compactionKey: 'todo:1',
      kind: 'update',
    }
    const out = compactLog([dup, dup])
    expect(out).toEqual([dup, dup])
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

  test('create followed by updates keeps every replay step', () => {
    const log: DraftCommand[] = [
      { path: 'addTodo', args: { id: 1, title: 'a' }, compactionKey: 'todo:1', kind: 'create' },
      { path: 'renameTodo', args: { id: 1, title: 'b' }, compactionKey: 'todo:1', kind: 'update' },
      { path: 'renameTodo', args: { id: 1, title: 'c' }, compactionKey: 'todo:1', kind: 'update' },
    ]
    const out = compactLog(log)
    expect(out.map((c) => c.kind)).toEqual(['create', 'update', 'update'])
  })

  test('a later create supersedes earlier same-key draft history', () => {
    const log: DraftCommand[] = [
      { path: 'addTodo', args: { id: 1, title: 'a' }, compactionKey: 'todo:1', kind: 'create' },
      { path: 'renameTodo', args: { id: 1, title: 'b' }, compactionKey: 'todo:1', kind: 'update' },
      { path: 'addTodo', args: { id: 1, title: 'c' }, compactionKey: 'todo:1', kind: 'create' },
    ]

    const out = compactLog(log)

    expect(out).toEqual([log[2]])
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

  // --- replacing a CANONICAL row: delete-then-create (#89) ---------------
  //
  // The mirror image of `create → delete → create`. There the leading create is
  // draft-local, so nothing canonical exists and only the final create survives.
  // Here the leading DELETE targets a row that already exists canonically, so it
  // has to survive alongside the create — dropping it publishes an insert onto a
  // live primary key. The two cases are distinguished by whether the key had a
  // live draft-local create when the delete was appended.

  test('delete of a CANONICAL row then create on the same key keeps BOTH, in order', () => {
    const log: DraftCommand[] = [
      { path: 'removeTodo', args: { id: 1 }, compactionKey: 'todo:1', kind: 'delete' },
      {
        path: 'addTodo',
        args: { id: 1, title: 'replacement' },
        compactionKey: 'todo:1',
        kind: 'create',
      },
    ]
    const out = compactLog(log)
    expect(out.map((c) => c.kind)).toEqual(['delete', 'create'])
    expect((out[1].args as { title: string }).title).toBe('replacement')
  })

  test('canonical delete + create + update keeps all three, in order', () => {
    const log: DraftCommand[] = [
      { path: 'removeTodo', args: { id: 1 }, compactionKey: 'todo:1', kind: 'delete' },
      { path: 'addTodo', args: { id: 1, title: 'a' }, compactionKey: 'todo:1', kind: 'create' },
      { path: 'renameTodo', args: { id: 1, title: 'b' }, compactionKey: 'todo:1', kind: 'update' },
    ]
    expect(compactLog(log).map((c) => c.kind)).toEqual(['delete', 'create', 'update'])
  })

  test('canonical delete + create + delete collapses to the canonical delete alone', () => {
    // The second delete cancels the draft-local create (that row never existed
    // canonically), but must NOT also cancel the FIRST delete — the canonical
    // row still has to go, and the net effect of the draft is a removal.
    const log: DraftCommand[] = [
      { path: 'removeTodo', args: { id: 1 }, compactionKey: 'todo:1', kind: 'delete' },
      { path: 'addTodo', args: { id: 1, title: 'a' }, compactionKey: 'todo:1', kind: 'create' },
      { path: 'renameTodo', args: { id: 1, title: 'b' }, compactionKey: 'todo:1', kind: 'update' },
      { path: 'removeTodo', args: { id: 1 }, compactionKey: 'todo:1', kind: 'delete' },
    ]
    const out = compactLog(log)
    expect(out.map((c) => c.kind)).toEqual(['delete'])
    expect(out[0]).toBe(log[0]) // the FIRST delete — the one that targets canonical
  })

  test('compaction is idempotent for the canonical-replace case', () => {
    // `append` re-compacts the whole accumulated log every batch, so a second
    // pass over an already-compacted log must be a no-op — otherwise the
    // surviving delete + create would collapse further on the next append.
    const log: DraftCommand[] = [
      { path: 'removeTodo', args: { id: 1 }, compactionKey: 'todo:1', kind: 'delete' },
      { path: 'addTodo', args: { id: 1, title: 'a' }, compactionKey: 'todo:1', kind: 'create' },
    ]
    const once = compactLog(log)
    expect(compactLog(once)).toEqual(once)
  })
})
