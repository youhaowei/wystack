import { type SemVer, type ISOTimestamp } from '@wystack/types'
import { Version, type VersionDiff } from './version'

export interface ChangelogEntry {
  version: SemVer
  date: ISOTimestamp
  description: string
  breaking: boolean
}

export interface SchemaVersionConfig {
  current: SemVer
  changelog: ChangelogEntry[]
  staleness?: {
    maxAgeDays?: number
  }
}

export interface VersionedRecord {
  schemaVersion: SemVer
  versionedAt: ISOTimestamp
}

export type StalenessPriority = 'critical' | 'recommended' | 'optional' | 'low'
export type StalenessReason =
  | 'version_major'
  | 'version_minor'
  | 'version_patch'
  | 'version_prerelease'
  | 'time_expired'

export type StalenessResult =
  | { stale: true; reason: StalenessReason; priority: StalenessPriority; diff?: VersionDiff }
  | { stale: false }

const PRIORITY_MAP: Record<VersionDiff, { reason: StalenessReason; priority: StalenessPriority }> =
  {
    major: { reason: 'version_major', priority: 'critical' },
    minor: { reason: 'version_minor', priority: 'recommended' },
    patch: { reason: 'version_patch', priority: 'optional' },
    prerelease: { reason: 'version_prerelease', priority: 'optional' },
  }

export class SchemaVersion {
  readonly current: Version
  private readonly config: SchemaVersionConfig
  private readonly maxAgeMs: number | null

  constructor(config: SchemaVersionConfig) {
    this.config = config
    this.current = new Version(config.current)
    this.maxAgeMs = config.staleness?.maxAgeDays
      ? config.staleness.maxAgeDays * 24 * 60 * 60 * 1000
      : null
  }

  checkStaleness(record: VersionedRecord, now?: Date): StalenessResult {
    const recordVersion = new Version(record.schemaVersion)

    // Version lag takes priority
    if (this.current.gt(recordVersion)) {
      const diff = this.current.diff(recordVersion)!
      return { stale: true, ...PRIORITY_MAP[diff], diff }
    }

    // Time-based staleness
    if (this.maxAgeMs !== null) {
      const versionedAt = new Date(record.versionedAt)
      const ageMs = (now ?? new Date()).getTime() - versionedAt.getTime()
      if (ageMs > this.maxAgeMs) {
        return { stale: true, reason: 'time_expired', priority: 'low' }
      }
    }

    return { stale: false }
  }

  changesSince(version: SemVer): ChangelogEntry[] {
    const since = new Version(version)
    return this.config.changelog.filter((entry) => {
      const entryVersion = new Version(entry.version)
      return entryVersion.gt(since)
    })
  }

  hasBreakingChangesSince(version: SemVer): boolean {
    return this.changesSince(version).some((entry) => entry.breaking)
  }
}
