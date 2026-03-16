import { type SemVer, semver, parseSemVer } from '@wystack/types'

export type VersionDiff = 'major' | 'minor' | 'patch'

export class Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly raw: SemVer

  constructor(version: SemVer | string) {
    this.raw = typeof version === 'string' ? semver(version) : version
    const parsed = parseSemVer(this.raw)
    this.major = parsed.major
    this.minor = parsed.minor
    this.patch = parsed.patch
  }

  private resolve(other: Version | SemVer | string): Version {
    return other instanceof Version ? other : new Version(other as string)
  }

  gt(other: Version | SemVer | string) {
    return this.compare(this.resolve(other)) > 0
  }

  gte(other: Version | SemVer | string) {
    return this.compare(this.resolve(other)) >= 0
  }

  lt(other: Version | SemVer | string) {
    return this.compare(this.resolve(other)) < 0
  }

  lte(other: Version | SemVer | string) {
    return this.compare(this.resolve(other)) <= 0
  }

  eq(other: Version | SemVer | string) {
    return this.compare(this.resolve(other)) === 0
  }

  diff(other: Version | SemVer | string): VersionDiff | null {
    const o = this.resolve(other)
    if (this.major !== o.major) return 'major'
    if (this.minor !== o.minor) return 'minor'
    if (this.patch !== o.patch) return 'patch'
    return null
  }

  private compare(other: Version): number {
    if (this.major !== other.major) return this.major - other.major
    if (this.minor !== other.minor) return this.minor - other.minor
    return this.patch - other.patch
  }

  toString() {
    return this.raw
  }
}
