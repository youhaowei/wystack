import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

const packageRoot = resolve(import.meta.dir, '..')
const fixture = (name) => resolve(packageRoot, 'test/fixtures', name)

const lint = (...paths) => {
  const result = Bun.spawnSync({
    cmd: [
      'oxlint',
      '--config',
      resolve(paths[0], 'fixture.oxlintrc.json'),
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

describe('@wystack/lint', () => {
  test('rejects broad object parameters while allowing generic constraints', () => {
    const root = fixture('no-object-parameters')
    const report = lint(root, resolve(root, 'input.ts'))

    expect(ruleMessages(report, 'no-object-parameters')).toHaveLength(3)
  })

  test('lets consumers exempt test files from chained assertion enforcement', () => {
    const root = fixture('no-chained-type-assertions')
    const report = lint(root, resolve(root, 'production.ts'), resolve(root, 'production.test.ts'))

    expect(ruleMessages(report, 'no-chained-type-assertions')).toHaveLength(3)
  })

  test('checks only configured const widening targets', () => {
    const root = fixture('no-known-value-widening')
    const report = lint(root, resolve(root, 'input.ts'))

    expect(ruleMessages(report, 'no-known-value-widening')).toHaveLength(3)
  })

  test('allows only canonical Proxy get forwarding', () => {
    const root = fixture('no-reflect-get')
    const report = lint(root, resolve(root, 'input.ts'))

    expect(ruleLines(report, 'no-reflect-get')).toEqual([5, 15, 22, 31, 42, 49, 66])
  })

  test('applies module-mock policy only to consumer-selected domain test paths', () => {
    const root = fixture('no-module-mocks-in-domain-tests')
    const report = lint(
      root,
      resolve(root, 'engine.domain.test.ts'),
      resolve(root, 'namespace.domain.test.ts'),
      resolve(root, 'late-import.domain.test.ts'),
      resolve(root, 'global.domain.test.ts'),
      resolve(root, 'shadowed.domain.test.ts'),
      resolve(root, 'component.test.ts'),
    )

    expect(ruleMessages(report, 'no-module-mocks-in-domain-tests')).toHaveLength(4)
  })

  test('rejects only exact configured placeholder declaration names', () => {
    const root = fixture('no-placeholder-symbol-names')
    const report = lint(root, resolve(root, 'input.ts'))

    expect(ruleMessages(report, 'no-placeholder-symbol-names')).toHaveLength(13)
  })
})
