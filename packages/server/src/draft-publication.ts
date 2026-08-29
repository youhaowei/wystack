import {
  eq,
  jsonNull,
  resolvePkColumnName,
  tryGetTableCapabilities,
  type DrizzleTracker,
} from '@wystack/db'
import { getTableColumns } from 'drizzle-orm'
import { getTableConfig } from 'drizzle-orm/pg-core'
import { inspectDraftRows } from './draft-inspection'
import {
  DraftPublishDriftError,
  type DraftInspectionRow,
  type DraftInspectionValue,
  type DraftPublishDrift,
} from './draft-lifecycle-types'
import { stableJson } from './stable-json'

type AnyTable = Parameters<DrizzleTracker['from']>[0]

function encodedIdentityValue(identity: unknown): unknown {
  if (!identity || typeof identity !== 'object' || !Object.hasOwn(identity, 'value')) {
    throw new Error('draft lifecycle: malformed stored row identity')
  }
  return (identity as { value: unknown }).value
}

function changeTarget(row: DraftInspectionRow): string {
  return `${row.table}\u0000${stableJson(row.tenantKey)}\u0000${stableJson(row.rowKey)}`
}

function driftTarget(row: DraftInspectionRow): Omit<DraftPublishDrift, 'reason'> {
  return {
    table: row.table,
    id: encodedIdentityValue(row.rowKey),
    ...(row.tenantKey ? { tenantId: encodedIdentityValue(row.tenantKey) } : {}),
  }
}

function effectiveReviewedRows(rows: DraftInspectionRow[]): DraftInspectionRow[] {
  // A create followed by a delete compacts to a harmless tombstone.
  return rows.filter((row) => row.baseExists || row.operation !== 'delete')
}

function proposedFields(row: DraftInspectionRow): Record<string, DraftInspectionValue> {
  if (row.operation === 'delete') return {}
  return Object.fromEntries(Object.entries(row.fields).map(([name, field]) => [name, field.value]))
}

function anchoredFields(row: DraftInspectionRow): Record<string, DraftInspectionValue> {
  return Object.fromEntries(
    Object.entries(row.fields).map(([name, field]) => [name, field.original]),
  )
}

/**
 * A publish-time replay is a consistency oracle, not the publication source.
 * It must resolve the same rows, proposals, and reviewed anchors as append did.
 */
export async function assertReplayMatchesReviewedChanges(
  raw: DrizzleTracker['raw'],
  draftId: string,
  replayDraftId: string,
): Promise<void> {
  const reviewed = new Map(
    effectiveReviewedRows(await inspectDraftRows(raw, draftId)).map((row) => [
      changeTarget(row),
      row,
    ]),
  )
  const replayed = new Map(
    effectiveReviewedRows(await inspectDraftRows(raw, replayDraftId)).map((row) => [
      changeTarget(row),
      row,
    ]),
  )
  const differences: DraftPublishDrift[] = []
  for (const target of [...new Set([...reviewed.keys(), ...replayed.keys()])].sort()) {
    const expected = reviewed.get(target)
    const actual = replayed.get(target)
    const row = expected ?? actual!
    const difference = driftTarget(row)
    if (!expected || !actual) {
      differences.push({ ...difference, reason: 'target' })
      continue
    }
    if (
      expected.operation !== actual.operation ||
      stableJson(proposedFields(expected)) !== stableJson(proposedFields(actual))
    ) {
      differences.push({ ...difference, reason: 'value' })
      continue
    }
    if (
      expected.baseExists !== actual.baseExists ||
      stableJson(expected.baseRevision) !== stableJson(actual.baseRevision) ||
      stableJson(anchoredFields(expected)) !== stableJson(anchoredFields(actual))
    ) {
      differences.push({ ...difference, reason: 'anchor' })
    }
  }
  if (differences.length > 0) throw new DraftPublishDriftError(draftId, differences)
}

interface ReviewedColumn {
  name: string
  getSQLType(): string
  mapFromDriverValue(value: unknown): unknown
  baseColumn?: ReviewedColumn
}

interface ResolvedReviewedChange {
  source: DraftInspectionRow
  table: AnyTable
  columns: Record<string, ReviewedColumn>
  pkProperty: string
  pkValue: unknown
  values: Record<string, unknown>
  originalRow?: Record<string, unknown>
  finalRow?: Record<string, unknown>
  revisionProperty?: string
  desiredRevision?: unknown
}

interface ReviewedChangeStep {
  change: ResolvedReviewedChange
  kind: 'delete' | 'write'
}

function decodeStoredDriverValue(value: unknown, column: ReviewedColumn): unknown {
  const sqlType = column.getSQLType().toLowerCase()
  if (
    sqlType.startsWith('timestamp') &&
    typeof value === 'string' &&
    /(?:z|[+-]\d\d:\d\d)$/i.test(value)
  ) {
    const decoded = new Date(value)
    if (!Number.isNaN(decoded.valueOf())) return decoded
  }
  return column.mapFromDriverValue(value)
}

function decodeReviewedValue(value: DraftInspectionValue, column: ReviewedColumn): unknown {
  if (value.kind === 'absent') return undefined
  if (value.kind === 'sql-null') return null
  if (value.kind === 'json') return value.value === null ? jsonNull() : value.value
  if (column.getSQLType().toLowerCase().endsWith('[]') && Array.isArray(value.value)) {
    return column.baseColumn
      ? value.value.map((element) => decodeStoredDriverValue(element, column.baseColumn!))
      : value.value
  }
  return decodeStoredDriverValue(value.value, column)
}

function reviewedRowVersion(
  change: DraftInspectionRow,
  columns: Record<string, ReviewedColumn>,
  side: 'original' | 'value',
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(change.fields).flatMap(([sqlName, field]) => {
      const entry = Object.entries(columns).find(([, column]) => column.name === sqlName)
      if (!entry) return []
      const decoded = decodeReviewedValue(field[side], entry[1])
      return decoded === undefined ? [] : [[entry[0], decoded]]
    }),
  )
}

async function resolveReviewedChange(
  tracker: DrizzleTracker,
  draftId: string,
  reviewed: ReturnType<DrizzleTracker['withDraft']>,
  change: DraftInspectionRow,
  liveTables: Map<string, AnyTable>,
): Promise<ResolvedReviewedChange> {
  const table = liveTables.get(change.table)
  const pkValue = encodedIdentityValue(change.rowKey)
  if (!table) {
    throw new DraftPublishDriftError(draftId, [{ ...driftTarget(change), reason: 'target' }])
  }
  const config = getTableConfig(table)
  const columns = getTableColumns(table) as Record<string, ReviewedColumn>
  const pkColumn = resolvePkColumnName(table, config)
  const pkEntry = Object.entries(columns).find(([, column]) => column.name === pkColumn)
  if (!pkEntry) throw new Error(`draft lifecycle: cannot resolve primary key for "${change.table}"`)
  const [pkProperty] = pkEntry
  const capabilities = tryGetTableCapabilities(table)
  const revisionProperty = capabilities?.revisionProperty
  const values = reviewedRowVersion(change, columns, 'value')
  if (revisionProperty) delete values[revisionProperty]

  let finalRow: Record<string, unknown> | undefined
  if (change.operation !== 'delete') {
    finalRow = (await reviewed.from(table).where(eq(pkProperty, pkValue)).first()) ?? undefined
    if (!finalRow) {
      throw new DraftPublishDriftError(draftId, [{ ...driftTarget(change), reason: 'target' }])
    }
  }
  const originalRow = change.baseExists
    ? {
        ...(finalRow ?? {}),
        [pkProperty]: pkValue,
        ...reviewedRowVersion(change, columns, 'original'),
        ...(capabilities?.tenancy && change.tenantKey
          ? {
              [capabilities.tenancy.property]: encodedIdentityValue(change.tenantKey),
            }
          : {}),
      }
    : undefined

  return {
    source: change,
    table,
    columns,
    pkProperty,
    pkValue,
    values,
    originalRow,
    finalRow,
    revisionProperty,
    desiredRevision: revisionProperty ? finalRow?.[revisionProperty] : undefined,
  }
}

function foreignKeyTuple(
  row: Record<string, unknown> | undefined,
  properties: string[],
): string | undefined {
  if (!row) return undefined
  const values = properties.map((property) => row[property])
  if (values.some((value) => value === null || value === undefined)) return undefined
  return stableJson(values)
}

function propertyForColumn(
  columns: Record<string, ReviewedColumn>,
  column: { name: string },
): string {
  const entry = Object.entries(columns).find(([, candidate]) => candidate.name === column.name)
  if (!entry) throw new Error(`draft lifecycle: cannot resolve foreign-key column "${column.name}"`)
  return entry[0]
}

function orderReviewedChangeSteps(changes: ResolvedReviewedChange[]): ReviewedChangeStep[] {
  const deleteSteps = new Map<number, number>()
  const writeSteps = new Map<number, number>()
  const steps: ReviewedChangeStep[] = []
  for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
    const change = changes[changeIndex]
    if (
      change.source.operation === 'delete' ||
      (change.source.operation === 'insert' && change.source.baseExists)
    ) {
      deleteSteps.set(changeIndex, steps.length)
      steps.push({ change, kind: 'delete' })
    }
    if (change.source.operation !== 'delete') {
      writeSteps.set(changeIndex, steps.length)
      steps.push({ change, kind: 'write' })
    }
  }
  const outgoing = steps.map(() => new Set<number>())
  const incoming = steps.map(() => 0)
  const addEdge = (before: number, after: number) => {
    if (before === after || outgoing[before].has(after)) return
    outgoing[before].add(after)
    incoming[after] += 1
  }

  for (let changeIndex = 0; changeIndex < changes.length; changeIndex += 1) {
    const remove = deleteSteps.get(changeIndex)
    const write = writeSteps.get(changeIndex)
    if (remove !== undefined && write !== undefined) addEdge(remove, write)
  }

  for (let childIndex = 0; childIndex < changes.length; childIndex += 1) {
    const child = changes[childIndex]
    for (const foreignKey of getTableConfig(child.table).foreignKeys) {
      const reference = foreignKey.reference()
      const childProperties = reference.columns.map((column) =>
        propertyForColumn(child.columns, column),
      )
      const childOriginal = foreignKeyTuple(child.originalRow, childProperties)
      const childFinal = foreignKeyTuple(child.finalRow, childProperties)

      for (let parentIndex = 0; parentIndex < changes.length; parentIndex += 1) {
        const parent = changes[parentIndex]
        if (parent.table !== reference.foreignTable) continue
        const parentProperties = reference.foreignColumns.map((column) =>
          propertyForColumn(parent.columns, column),
        )
        const parentOriginal = foreignKeyTuple(parent.originalRow, parentProperties)
        const parentFinal = foreignKeyTuple(parent.finalRow, parentProperties)
        const childRelease =
          deleteSteps.get(childIndex) ??
          (childOriginal !== childFinal ? writeSteps.get(childIndex) : undefined)
        const childAcquire =
          child.source.operation === 'insert' || childOriginal !== childFinal
            ? writeSteps.get(childIndex)
            : undefined
        const parentLose =
          deleteSteps.get(parentIndex) ??
          (parentOriginal !== parentFinal ? writeSteps.get(parentIndex) : undefined)
        const parentProvide =
          parent.source.operation === 'insert' || parentOriginal !== parentFinal
            ? writeSteps.get(parentIndex)
            : undefined

        if (
          childOriginal !== undefined &&
          childOriginal === parentOriginal &&
          childRelease !== undefined &&
          parentLose !== undefined
        ) {
          addEdge(childRelease, parentLose)
        }
        if (
          childFinal !== undefined &&
          childFinal === parentFinal &&
          childAcquire !== undefined &&
          parentProvide !== undefined
        ) {
          addEdge(parentProvide, childAcquire)
        }
      }
    }
  }

  const ready = steps.flatMap((_, index) => (incoming[index] === 0 ? [index] : []))
  const ordered: ReviewedChangeStep[] = []
  while (ready.length > 0) {
    ready.sort((left, right) => left - right)
    const index = ready.shift()!
    ordered.push(steps[index])
    for (const dependent of outgoing[index]) {
      incoming[dependent] -= 1
      if (incoming[dependent] === 0) ready.push(dependent)
    }
  }
  if (ordered.length !== steps.length) {
    throw new Error(
      'draft lifecycle: reviewed changes contain an immediate foreign-key cycle that cannot be published safely',
    )
  }
  return ordered
}

async function advanceReviewedRevision(
  tracker: DrizzleTracker,
  draftId: string,
  change: ResolvedReviewedChange,
): Promise<void> {
  const revision = change.revisionProperty
  if (!revision) return
  if (typeof change.desiredRevision !== 'number') {
    throw new Error(`draft lifecycle: invalid reviewed revision for "${change.source.table}"`)
  }
  let published = await tracker
    .from(change.table)
    .where(eq(change.pkProperty, change.pkValue))
    .first()
  let publishedRevision = published?.[revision]
  while (
    published &&
    typeof publishedRevision === 'number' &&
    publishedRevision < change.desiredRevision
  ) {
    const previousRevision = publishedRevision
    await tracker
      .from(change.table)
      .where(eq(change.pkProperty, change.pkValue))
      .update(change.values)
    published = await tracker
      .from(change.table)
      .where(eq(change.pkProperty, change.pkValue))
      .first()
    publishedRevision = published?.[revision]
    if (
      !published ||
      typeof publishedRevision !== 'number' ||
      publishedRevision <= previousRevision
    ) {
      throw new DraftPublishDriftError(draftId, [
        { ...driftTarget(change.source), reason: 'anchor' },
      ])
    }
  }
  if (!published || publishedRevision !== change.desiredRevision) {
    throw new DraftPublishDriftError(draftId, [{ ...driftTarget(change.source), reason: 'anchor' }])
  }
}

async function applyReviewedChangeStep(
  tracker: DrizzleTracker,
  draftId: string,
  step: ReviewedChangeStep,
): Promise<void> {
  const { change } = step
  const where = tracker.from(change.table).where(eq(change.pkProperty, change.pkValue))
  if (step.kind === 'delete') {
    await where.delete()
    return
  }
  if (change.source.operation === 'insert') {
    await tracker
      .into(change.table)
      .insert({ [change.pkProperty]: change.pkValue, ...change.values })
  } else if (Object.keys(change.values).length > 0 || change.revisionProperty) {
    await where.update(change.values)
  }
  await advanceReviewedRevision(tracker, draftId, change)
}

/** Apply reviewed changes in immediate-foreign-key-safe order. */
export async function applyReviewedChanges(
  tracker: DrizzleTracker,
  draftId: string,
  liveTables: Map<string, AnyTable>,
): Promise<void> {
  const reviewed = tracker.withDraft(draftId)
  const inspected = effectiveReviewedRows(await inspectDraftRows(tracker.raw, draftId))
  const resolved = await Promise.all(
    inspected.map((change) =>
      resolveReviewedChange(tracker, draftId, reviewed, change, liveTables),
    ),
  )
  for (const step of orderReviewedChangeSteps(resolved)) {
    await applyReviewedChangeStep(tracker, draftId, step)
  }
}
