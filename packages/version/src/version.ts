import { type SemVer, semver, parseSemVer } from '@wystack/types'

export type VersionDiff = 'major' | 'minor' | 'patch' | 'prerelease'

export class Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: string | undefined
  readonly raw: SemVer

  constructor(version: SemVer | string) {
    this.raw = typeof version === 'string' ? semver(version) : version
    const parsed = parseSemVer(this.raw)
    this.major = parsed.major
    this.minor = parsed.minor
    this.patch = parsed.patch
    this.prerelease = parsed.prerelease
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
    if (this.prerelease !== o.prerelease) return 'prerelease'
    return null
  }

  private compare(other: Version): number {
    if (this.major !== other.major) return this.major - other.major
    if (this.minor !== other.minor) return this.minor - other.minor
    if (this.patch !== other.patch) return this.patch - other.patch
    // Pre-release versions have lower precedence than release (semver spec §11)
    // No prerelease = release, which is greater than any prerelease
    if (this.prerelease === other.prerelease) return 0
    if (this.prerelease === undefined) return 1 // release > prerelease
    if (other.prerelease === undefined) return -1 // prerelease < release
    return comparePrerelease(this.prerelease, other.prerelease)
  }

  toString() {
    return this.raw
  }
}

/**
 * Compare pre-release identifiers per semver spec §11.4:
 * Split by '.', compare each segment — numeric segments compare as integers,
 * alphanumeric segments compare lexically, numeric < alphanumeric.
 */
function comparePrerelease(a: string, b: string): number {
  const partsA = a.split('.')
  const partsB = b.split('.')
  const len = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < len; i++) {
    if (i >= partsA.length) return -1 // fewer segments = lower precedence
    if (i >= partsB.length) return 1
    const segA = partsA[i]
    const segB = partsB[i]
    const numA = /^\d+$/.test(segA) ? Number(segA) : null
    const numB = /^\d+$/.test(segB) ? Number(segB) : null
    if (numA !== null && numB !== null) {
      if (numA !== numB) return numA - numB
    } else if (numA !== null) {
      return -1 // numeric < alphanumeric
    } else if (numB !== null) {
      return 1
    } else {
      const cmp = segA < segB ? -1 : segA > segB ? 1 : 0
      if (cmp !== 0) return cmp
    }
  }
  return 0
}
