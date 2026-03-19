import { describe, test, expect } from 'bun:test'
import { Version, SchemaVersion, semver, isoFrom } from '../index'

describe('Version', () => {
  test('parses semver components', () => {
    const v = new Version('2.10.3')
    expect(v.major).toBe(2)
    expect(v.minor).toBe(10)
    expect(v.patch).toBe(3)
    expect(String(v.raw)).toBe('2.10.3')
  })

  test('accepts SemVer branded type', () => {
    const v = new Version(semver('1.0.0'))
    expect(v.major).toBe(1)
  })

  test('rejects invalid version', () => {
    expect(() => new Version('bad')).toThrow(TypeError)
  })

  test('gt comparison', () => {
    const v2 = new Version('2.0.0')
    expect(v2.gt('1.0.0')).toBe(true)
    expect(v2.gt('2.0.0')).toBe(false)
    expect(v2.gt('3.0.0')).toBe(false)
  })

  test('lt comparison', () => {
    const v1 = new Version('1.5.0')
    expect(v1.lt('2.0.0')).toBe(true)
    expect(v1.lt('1.5.0')).toBe(false)
    expect(v1.lt('1.4.0')).toBe(false)
  })

  test('eq comparison', () => {
    expect(new Version('1.0.0').eq('1.0.0')).toBe(true)
    expect(new Version('1.0.0').eq('1.0.1')).toBe(false)
  })

  test('gte and lte', () => {
    const v = new Version('2.1.0')
    expect(v.gte('2.1.0')).toBe(true)
    expect(v.gte('2.0.0')).toBe(true)
    expect(v.gte('2.2.0')).toBe(false)
    expect(v.lte('2.1.0')).toBe(true)
    expect(v.lte('3.0.0')).toBe(true)
    expect(v.lte('1.0.0')).toBe(false)
  })

  test('diff identifies change level', () => {
    const v = new Version('2.1.3')
    expect(v.diff('1.0.0')).toBe('major')
    expect(v.diff('2.0.0')).toBe('minor')
    expect(v.diff('2.1.0')).toBe('patch')
    expect(v.diff('2.1.3')).toBeNull()
  })

  test('diff is symmetric in type but not direction', () => {
    expect(new Version('3.0.0').diff('1.0.0')).toBe('major')
    expect(new Version('1.0.0').diff('3.0.0')).toBe('major')
  })

  test('toString returns raw string', () => {
    expect(String(new Version('1.2.3'))).toBe('1.2.3')
  })

  test('compares across Version instances and strings', () => {
    const a = new Version('1.0.0')
    const b = new Version('2.0.0')
    expect(a.lt(b)).toBe(true)
    expect(a.lt(semver('2.0.0'))).toBe(true)
    expect(a.lt('2.0.0')).toBe(true)
  })

  // Pre-release support
  test('parses pre-release segment', () => {
    const v = new Version('1.0.0-rc.1')
    expect(v.major).toBe(1)
    expect(v.minor).toBe(0)
    expect(v.patch).toBe(0)
    expect(v.prerelease).toBe('rc.1')
  })

  test('release has no prerelease', () => {
    expect(new Version('1.0.0').prerelease).toBeUndefined()
  })

  test('prerelease is less than release (semver §11)', () => {
    const rc = new Version('1.0.0-rc.1')
    const release = new Version('1.0.0')
    expect(rc.lt(release)).toBe(true)
    expect(release.gt(rc)).toBe(true)
  })

  test('rc.1 < rc.2 < release', () => {
    const rc1 = new Version('0.4.0-rc.1')
    const rc2 = new Version('0.4.0-rc.2')
    const release = new Version('0.4.0')
    expect(rc1.lt(rc2)).toBe(true)
    expect(rc2.lt(release)).toBe(true)
    expect(rc1.lt(release)).toBe(true)
  })

  test('prerelease diff detection', () => {
    expect(new Version('1.0.0-rc.1').diff('1.0.0')).toBe('prerelease')
    expect(new Version('1.0.0-rc.1').diff('1.0.0-rc.2')).toBe('prerelease')
    expect(new Version('1.0.0-rc.1').diff('1.0.0-rc.1')).toBeNull()
  })

  test('alpha < beta < rc (lexicographic)', () => {
    expect(new Version('1.0.0-alpha').lt('1.0.0-beta')).toBe(true)
    expect(new Version('1.0.0-beta').lt('1.0.0-rc.1')).toBe(true)
  })

  test('numeric prerelease segments compared as numbers', () => {
    // "rc.9" < "rc.10" (numeric, not lexicographic)
    expect(new Version('1.0.0-rc.9').lt('1.0.0-rc.10')).toBe(true)
  })

  test('eq works for prerelease versions', () => {
    expect(new Version('1.0.0-rc.1').eq('1.0.0-rc.1')).toBe(true)
    expect(new Version('1.0.0-rc.1').eq('1.0.0-rc.2')).toBe(false)
    expect(new Version('1.0.0-rc.1').eq('1.0.0')).toBe(false)
  })

  test('toString includes prerelease', () => {
    expect(String(new Version('1.0.0-rc.3'))).toBe('1.0.0-rc.3')
  })
})

describe('SchemaVersion', () => {
  const config = {
    current: semver('2.0.0'),
    changelog: [
      { version: semver('1.0.0'), date: isoFrom('2026-01-15'), description: 'Initial', breaking: false },
      { version: semver('1.1.0'), date: isoFrom('2026-02-20'), description: 'Added feature', breaking: false },
      { version: semver('2.0.0'), date: isoFrom('2026-03-16'), description: 'Breaking change', breaking: true },
    ],
    staleness: { maxAgeDays: 30 },
  }

  test('detects major version lag as critical', () => {
    const schema = new SchemaVersion(config)
    const result = schema.checkStaleness({
      schemaVersion: semver('1.0.0'),
      versionedAt: isoFrom(new Date()),
    })
    expect(result.stale).toBe(true)
    if (result.stale) {
      expect(result.reason).toBe('version_major')
      expect(result.priority).toBe('critical')
      expect(result.diff).toBe('major')
    }
  })

  test('detects minor version lag as recommended', () => {
    const schema = new SchemaVersion({
      ...config,
      current: semver('1.1.0'),
    })
    const result = schema.checkStaleness({
      schemaVersion: semver('1.0.0'),
      versionedAt: isoFrom(new Date()),
    })
    expect(result.stale).toBe(true)
    if (result.stale) {
      expect(result.reason).toBe('version_minor')
      expect(result.priority).toBe('recommended')
    }
  })

  test('detects patch version lag as optional', () => {
    const schema = new SchemaVersion({
      ...config,
      current: semver('1.0.1'),
    })
    const result = schema.checkStaleness({
      schemaVersion: semver('1.0.0'),
      versionedAt: isoFrom(new Date()),
    })
    expect(result.stale).toBe(true)
    if (result.stale) {
      expect(result.reason).toBe('version_patch')
      expect(result.priority).toBe('optional')
    }
  })

  test('detects time-based staleness', () => {
    const schema = new SchemaVersion(config)
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
    const result = schema.checkStaleness({
      schemaVersion: semver('2.0.0'), // version is current
      versionedAt: isoFrom(thirtyOneDaysAgo),
    })
    expect(result.stale).toBe(true)
    if (result.stale) {
      expect(result.reason).toBe('time_expired')
      expect(result.priority).toBe('low')
    }
  })

  test('reports not stale when current and fresh', () => {
    const schema = new SchemaVersion(config)
    const result = schema.checkStaleness({
      schemaVersion: semver('2.0.0'),
      versionedAt: isoFrom(new Date()),
    })
    expect(result).toEqual({ stale: false })
  })

  test('version lag takes priority over time staleness', () => {
    const schema = new SchemaVersion(config)
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    const result = schema.checkStaleness({
      schemaVersion: semver('1.0.0'),
      versionedAt: isoFrom(oldDate),
    })
    expect(result.stale).toBe(true)
    if (result.stale) {
      expect(result.reason).toBe('version_major') // not time_expired
    }
  })

  test('no time staleness without maxAgeDays config', () => {
    const schema = new SchemaVersion({
      current: semver('1.0.0'),
      changelog: [],
    })
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000)
    const result = schema.checkStaleness({
      schemaVersion: semver('1.0.0'),
      versionedAt: isoFrom(oldDate),
    })
    expect(result).toEqual({ stale: false })
  })

  test('changesSince returns entries after given version', () => {
    const schema = new SchemaVersion(config)
    const changes = schema.changesSince(semver('1.0.0'))
    expect(changes).toHaveLength(2)
    expect(String(changes[0].version)).toBe('1.1.0')
    expect(String(changes[1].version)).toBe('2.0.0')
  })

  test('changesSince with current version returns empty', () => {
    const schema = new SchemaVersion(config)
    expect(schema.changesSince(semver('2.0.0'))).toHaveLength(0)
  })

  test('hasBreakingChangesSince', () => {
    const schema = new SchemaVersion(config)
    expect(schema.hasBreakingChangesSince(semver('1.0.0'))).toBe(true)
    expect(schema.hasBreakingChangesSince(semver('1.1.0'))).toBe(true)
    expect(schema.hasBreakingChangesSince(semver('2.0.0'))).toBe(false)
  })

  test('detects prerelease-to-release staleness', () => {
    const schema = new SchemaVersion({
      current: semver('0.4.0'),
      changelog: [
        { version: semver('0.4.0'), date: isoFrom('2026-03-19'), description: 'Org-scoped artifacts', breaking: false },
      ],
    })
    const result = schema.checkStaleness({
      schemaVersion: semver('0.4.0-rc.2'),
      versionedAt: isoFrom(new Date()),
    })
    expect(result.stale).toBe(true)
    if (result.stale) {
      expect(result.reason).toBe('version_prerelease')
      expect(result.diff).toBe('prerelease')
    }
  })

  test('changesSince works with RC versions', () => {
    const schema = new SchemaVersion({
      current: semver('0.4.0'),
      changelog: [
        { version: semver('0.4.0-rc.1'), date: isoFrom('2026-03-17'), description: 'Extract plans', breaking: false },
        { version: semver('0.4.0-rc.2'), date: isoFrom('2026-03-18'), description: 'Add orgId', breaking: false },
        { version: semver('0.4.0'), date: isoFrom('2026-03-19'), description: 'Org-scoped artifacts', breaking: false },
      ],
    })
    // Session at rc.1 should see rc.2 and release
    const changes = schema.changesSince(semver('0.4.0-rc.1'))
    expect(changes).toHaveLength(2)
    expect(String(changes[0].version)).toBe('0.4.0-rc.2')
    expect(String(changes[1].version)).toBe('0.4.0')
  })

  test('checkStaleness accepts now override for deterministic tests', () => {
    const schema = new SchemaVersion(config)
    const fixedNow = new Date('2026-04-20T00:00:00Z')
    const twentyDaysAgo = new Date('2026-03-31T00:00:00Z')
    const result = schema.checkStaleness(
      { schemaVersion: semver('2.0.0'), versionedAt: isoFrom(twentyDaysAgo) },
      fixedNow,
    )
    expect(result).toEqual({ stale: false }) // 20 days < 30 day max
  })
})
