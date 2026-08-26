import type { Command } from './apply-commands'

export type ResolveHook = (log: Command[]) => Command[] | Promise<Command[]>

export interface DraftCommand extends Command {
  /** Opaque per-target key; same key means the same logical cell history. */
  compactionKey?: string
  kind?: 'create' | 'update' | 'delete'
}

/**
 * Conservatively compact commands that name the same logical cell. Updates
 * remain ordered because an opaque key cannot prove two commands are safely
 * mergeable. A later create supersedes earlier same-key draft history; a delete
 * cancels a draft-local create history or supersedes canonical updates.
 */
export function compactLog(log: DraftCommand[]): DraftCommand[] {
  const survivingCreate = new Map<string, number>()
  const survivingUpdates = new Map<string, number[]>()
  const survivingDelete = new Map<string, number>()

  for (let index = 0; index < log.length; index++) {
    const command = log[index]
    const key = command.compactionKey
    if (key === undefined || command.kind === undefined) continue
    if (command.kind === 'create') {
      survivingCreate.set(key, index)
      survivingUpdates.delete(key)
    } else if (command.kind === 'update') {
      const updates = survivingUpdates.get(key) ?? []
      updates.push(index)
      survivingUpdates.set(key, updates)
    } else if (survivingCreate.has(key)) {
      survivingCreate.delete(key)
      survivingUpdates.delete(key)
    } else {
      survivingUpdates.delete(key)
      survivingDelete.set(key, index)
    }
  }

  const survivingIndices = new Set<number>()
  for (const positions of [survivingCreate, survivingDelete]) {
    for (const index of positions.values()) survivingIndices.add(index)
  }
  for (const positions of survivingUpdates.values()) {
    for (const index of positions) survivingIndices.add(index)
  }

  return log.filter(
    (command, index) =>
      command.compactionKey === undefined ||
      command.kind === undefined ||
      survivingIndices.has(index),
  )
}

export function snapshotJsonValue(
  value: unknown,
  path: string,
  ancestors = new Set<object>(),
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`draft lifecycle: ${path} must contain only finite JSON numbers`)
    }
    return Object.is(value, -0) ? 0 : value
  }
  if (value === undefined) return undefined
  if (typeof value !== 'object') {
    throw new Error(`draft lifecycle: ${path} must be JSON-compatible`)
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`draft lifecycle: ${path} must not contain an invalid Date`)
    }
    return value.toISOString()
  }
  if (ancestors.has(value)) {
    throw new Error(`draft lifecycle: ${path} must not contain a cycle`)
  }
  ancestors.add(value)

  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol')) {
      throw new Error(`draft lifecycle: ${path} must not contain symbol properties`)
    }
    const out: unknown[] = []
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index) || value[index] === undefined) {
        throw new Error(`draft lifecycle: ${path}[${index}] must not be missing or undefined`)
      }
      out.push(snapshotJsonValue(value[index], `${path}[${index}]`, ancestors))
    }
    const expectedKeys = new Set(Array.from({ length: value.length }, (_, index) => String(index)))
    if (Object.keys(value).some((key) => !expectedKeys.has(key))) {
      throw new Error(`draft lifecycle: ${path} arrays must not contain named properties`)
    }
    ancestors.delete(value)
    return out
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`draft lifecycle: ${path} must contain only plain JSON objects`)
  }
  const entries: Array<[string, unknown]> = []
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') {
      throw new Error(`draft lifecycle: ${path} must not contain symbol properties`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error(`draft lifecycle: ${path}.${key} must be an enumerable data property`)
    }
    if (descriptor.value === undefined) continue
    entries.push([key, snapshotJsonValue(descriptor.value, `${path}.${key}`, ancestors)])
  }
  ancestors.delete(value)
  return Object.fromEntries(entries)
}

/** Canonicalize before derived execution and durable JSONB persistence. */
export function snapshotCommand(command: DraftCommand): DraftCommand {
  return {
    ...(command.id === undefined ? {} : { id: command.id }),
    path: command.path,
    args: snapshotJsonValue(command.args, 'command args'),
    ...(command.compactionKey === undefined ? {} : { compactionKey: command.compactionKey }),
    ...(command.kind === undefined ? {} : { kind: command.kind }),
  }
}
