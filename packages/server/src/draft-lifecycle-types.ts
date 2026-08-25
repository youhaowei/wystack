import type { DraftDrizzleTracker, DrizzleTracker } from '@wystack/db'
import type { CommandResult, CommitResult } from './apply-commands'
import type { DraftCommand, ResolveHook } from './draft-command-log'

export interface Cell {
  table: string
  id: unknown
}

/** Opaque canonical snapshot token whose ordering belongs to the application. */
export type Version = unknown

export interface VersionProbe {
  current(): Promise<Version>
  isNewerThan(current: Version, base: Version): boolean
  cellsWrittenSince(base: Version, cells: Cell[]): Promise<Cell[]>
}

export interface ConflictReport {
  /** Canonical advanced, but may have touched only disjoint cells. */
  staleBase: boolean
  /** Draft-touched cells canonical also wrote at or after the base version. */
  overlappingCells: Cell[]
}

export interface DraftRowConflict {
  table: string
  id: unknown
  reason: 'created' | 'deleted' | 'revision'
}

export class DraftConflictError extends Error {
  readonly conflicts: DraftRowConflict[]

  constructor(draftId: string, conflicts: DraftRowConflict[]) {
    super(`draft lifecycle: draft "${draftId}" conflicts with published data`)
    this.name = 'DraftConflictError'
    this.conflicts = conflicts
  }
}

export interface OpenOptions {
  context?: Record<string, unknown>
}

export interface DraftOperationOptions {
  context?: Record<string, unknown>
}

export interface RebaseOptions extends DraftOperationOptions {
  acceptConflicts?: (report: ConflictReport) => boolean | Promise<boolean>
}

export interface DraftLifecycleOptions {
  versionProbe?: VersionProbe
  resolveOwner?: (context: Record<string, unknown>) => unknown | Promise<unknown>
  authorizeDraft?: (request: DraftAuthorizationRequest) => boolean | Promise<boolean>
  validateGraph?: (request: DraftGraphValidationRequest) => void | Promise<void>
}

export interface DraftGraphValidationRequest {
  phase: 'effective' | 'published'
  draftId: string
  db: DrizzleTracker | DraftDrizzleTracker
  context: Record<string, unknown>
}

export interface DraftAuthorizationRequest {
  action: 'append' | 'publish' | 'discard' | 'rebase' | 'detectConflict' | 'inspect' | 'getLog'
  draft: {
    draftId: string
    tenantId: unknown | undefined
    ownerKey: unknown | undefined
  }
  context: Record<string, unknown>
}

export interface DraftInspectionRow {
  draftId: string
  table: string
  tenantKey: unknown
  rowKey: unknown
  operation: 'insert' | 'update' | 'delete'
  baseExists: boolean
  baseRevision: unknown
  fields: Record<
    string,
    {
      original: DraftInspectionValue
      value: DraftInspectionValue
    }
  >
}

export type DraftInspectionValue =
  | { kind: 'absent' }
  | { kind: 'sql-null' }
  | { kind: 'json'; value: unknown }
  | { kind: 'value'; value: unknown }

export interface DraftLifecycle {
  open(baseVersion: Version, opts?: OpenOptions): Promise<string>
  /** Persist and execute commands against the effective draft relation atomically. */
  append(
    draftId: string,
    batch: DraftCommand[],
    opts?: DraftOperationOptions,
  ): Promise<CommandResult[]>
  /** Replay the authoritative command log and sweep derived state in one transaction. */
  publish(
    draftId: string,
    resolve?: ResolveHook,
    opts?: DraftOperationOptions,
  ): Promise<CommitResult>
  discard(draftId: string, opts?: DraftOperationOptions): Promise<void>
  rebase(draftId: string, opts?: RebaseOptions): Promise<ConflictReport>
  detectConflict(draftId: string, opts?: DraftOperationOptions): Promise<ConflictReport>
  inspect(draftId: string, opts?: DraftOperationOptions): Promise<DraftInspectionRow[]>
  getLog(draftId: string, opts?: DraftOperationOptions): Promise<DraftCommand[]>
}
