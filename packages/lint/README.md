# @wystack/lint

Reusable Oxlint rules for keeping TypeScript contracts precise without forcing a
project's architecture or test layout.

```ts
import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: {
    jsPlugins: [{ name: 'wystack', specifier: '@wystack/lint' }],
    rules: {
      'wystack/no-object-parameters': 'error',
      'wystack/no-chained-type-assertions': 'error',
      'wystack/no-known-value-widening': ['error', { targets: ['primitive', 'record'] }],
      'wystack/no-reflect-get': 'error',
      'wystack/no-placeholder-symbol-names': ['error', { names: ['shape'] }],
    },
    overrides: [
      {
        files: ['**/*.test.ts', '**/*.test.tsx'],
        rules: {
          'wystack/no-chained-type-assertions': 'off',
          'wystack/no-module-mocks-in-domain-tests': 'error',
        },
      },
    ],
  },
})
```

The chained-assertion rule intentionally has no built-in test-file exception:
each consumer chooses its own test and generated-file scope through standard
Oxlint overrides. `no-known-value-widening` intentionally inspects only `const`
declarations with static initializers; it does not police return annotations or
other public abstraction boundaries. Its `targets` option selects `primitive`,
`array`, and/or `record` checks.

`no-reflect-get` allows only `Reflect.get(target, property, receiver)` when it
forwards the first three parameters of a `get` method inside `new Proxy(...,
handler)`. This preserves JavaScript accessor receiver semantics while still
rejecting arbitrary reflective reads.

`no-module-mocks-in-domain-tests` recognizes `vi.mock` and `vi.doMock` from
Vitest and Vite+ Test (`vite-plus/test`). Apply it only to a consumer's domain
test globs through standard overrides. `no-placeholder-symbol-names` requires
an exact `names` denylist; it never rejects a domain name merely because it
contains a discouraged word.

See [the rule roadmap](./ROADMAP.md) for the deliberately deferred rules that
need richer analysis than an AST-only plugin can provide safely.
