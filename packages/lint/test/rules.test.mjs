import { describe, expect, test } from 'bun:test'
import { basename, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dir, '..')
const fixture = (name) => resolve(packageRoot, 'test/fixtures', name)

const lint = (configName, ...paths) => {
  const result = Bun.spawnSync({
    cmd: [
      'oxlint',
      '--config',
      resolve(paths[0], configName),
      '--format',
      'json',
      ...paths.slice(1),
    ],
    cwd: packageRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  return JSON.parse(new TextDecoder().decode(result.stdout))
}

const ruleMessages = (report, ruleName) =>
  report.diagnostics.filter((diagnostic) => diagnostic.code === `wystack(${ruleName})`)

const ruleLines = (report, ruleName) =>
  ruleMessages(report, ruleName).map((diagnostic) => diagnostic.labels[0].span.line)

const ruleLocations = (report, ruleName) =>
  ruleMessages(report, ruleName)
    .map((diagnostic) => `${basename(diagnostic.filename)}:${diagnostic.labels[0].span.line}`)
    .sort()

describe('@wystack/lint', () => {
  test('rejects broad object parameters while allowing generic constraints', () => {
    const root = fixture('no-object-parameters')
    const report = lint('fixture.oxlintrc.json', root, resolve(root, 'input.ts'))

    expect(ruleLines(report, 'no-object-parameters')).toEqual([1, 2, 5])
  })

  test('lets consumers exempt test files from chained assertion enforcement', () => {
    const root = fixture('no-chained-type-assertions')
    const report = lint(
      'fixture.oxlintrc.json',
      root,
      resolve(root, 'production.ts'),
      resolve(root, 'production.test.ts'),
    )

    expect(ruleLines(report, 'no-chained-type-assertions')).toEqual([2, 3, 4])
  })

  test('checks only configured const widening targets', () => {
    const root = fixture('no-known-value-widening')
    const primitive = lint('primitive.oxlintrc.json', root, resolve(root, 'input.ts'))
    const record = lint('record.oxlintrc.json', root, resolve(root, 'input.ts'))

    expect(ruleLines(primitive, 'no-known-value-widening')).toEqual([7, 8])
    expect(ruleLines(record, 'no-known-value-widening')).toEqual([9, 10, 11, 12, 13, 16])
  })

  test('allows only canonical Proxy get forwarding', () => {
    const root = fixture('no-reflect-get')
    const report = lint('fixture.oxlintrc.json', root, resolve(root, 'input.ts'))

    expect(ruleLines(report, 'no-reflect-get')).toEqual([5, 15, 22, 31, 42, 49, 66])
  })

  test('applies module-mock policy only to consumer-selected domain test paths', () => {
    const root = fixture('no-module-mocks-in-domain-tests')
    const report = lint(
      'fixture.oxlintrc.json',
      root,
      resolve(root, 'engine.domain.test.ts'),
      resolve(root, 'namespace.domain.test.ts'),
      resolve(root, 'late-import.domain.test.ts'),
      resolve(root, 'global.domain.test.ts'),
      resolve(root, 'shadowed.domain.test.ts'),
      resolve(root, 'component.test.ts'),
    )

    expect(ruleLocations(report, 'no-module-mocks-in-domain-tests')).toEqual([
      'engine.domain.test.ts:3',
      'global.domain.test.ts:1',
      'late-import.domain.test.ts:1',
      'namespace.domain.test.ts:3',
    ])
  })

  test('rejects only exact configured placeholder declaration and member names', () => {
    const root = fixture('no-placeholder-symbol-names')
    const report = lint('fixture.oxlintrc.json', root, resolve(root, 'input.ts'))

    expect(ruleLines(report, 'no-placeholder-symbol-names')).toEqual([
      1, 4, 5, 11, 16, 21, 23, 24, 28, 31, 33, 35, 37, 42,
    ])
  })

  test('rejects directly constructed imported PGlite instances', () => {
    const root = fixture('no-unmanaged-pglite')
    const report = lint(
      'fixture.oxlintrc.json',
      root,
      resolve(root, 'composed.fixture.ts'),
      resolve(root, 'database.ts'),
      resolve(root, 'input.ts'),
      resolve(root, 'local-db.ts'),
      resolve(root, 'local.ts'),
      resolve(root, 'managed.ts'),
      resolve(root, 'shared.fixture.ts'),
      resolve(root, 'unregistered.ts'),
    )

    expect(ruleLocations(report, 'no-unmanaged-pglite')).toEqual([
      'database.ts:3',
      'database.ts:6',
      'input.ts:3',
      'input.ts:7',
      'shared.fixture.ts:3',
      'unregistered.ts:2',
    ])
  })
})
