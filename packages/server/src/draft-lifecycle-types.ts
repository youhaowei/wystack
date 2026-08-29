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
  /** Read-only and replay-safe: rebase may call this again after a rolled-back transaction. */
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

export class DraftIntegrityError extends Error {
  constructor(draftId: string) {
    super(`draft lifecycle: draft "${draftId}" command log and materialized changes disagree`)
    this.name = 'DraftIntegrityError'
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
  /**
   * Grants access to drafts that have no tenant. Required for a tenant-aware app
   * (one built with `resolveTenant`), where such a draft is a privileged scope.
   * Optional for an app with no tenant dimension: there every draft is
   * app-scoped by construction, and installing this hook adds a gate rather
   * than satisfying one.
   */
  authorizeGlobalDraft?: (request: GlobalDraftAuthorizationRequest) => boolean | Promise<boolean>
  /**
   * Validate using the supplied transaction-bound database view. This hook must
   * be side-effect-free: PostgreSQL deadlock/serialization recovery may replay
   * the framework-owned lifecycle transaction that invokes it.
   */
  validateGraph?: (request: DraftGraphValidationRequest) => void | Promise<void>
}

export interface DraftGraphValidationRequest {
  phase: 'effective' | 'published'
  draftId: string
  db: DrizzleTracker | DraftDrizzleTracker
  context: Record<string, unknown>
}

export interface DraftAuthorizationRequest {
  action: DraftOperationAction
  draft: {
    draftId: string
    tenantId: unknown | undefined
    ownerKey: unknown
  }
  context: Record<string, unknown>
}

export type DraftOperationAction =
  | 'append'
  | 'publish'
  | 'discard'
  | 'rebase'
  | 'detectConflict'
  | 'inspect'
  | 'getLog'

export interface GlobalDraftAuthorizationRequest {
  action: 'open' | DraftOperationAction
  draft?: {
    draftId: string
    ownerKey: unknown
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
