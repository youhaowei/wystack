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
      'wystack/no-unmanaged-pglite': 'error',
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
other public abstraction boundaries. Its `targets` option selects `primitive`
and/or `record` checks. Mutable array literals intentionally are not a target:
without `as const`, TypeScript already infers their broad array type.

`no-reflect-get` allows only `Reflect.get(target, property, receiver)` when it
forwards the first three parameters of a `get` method inside `new Proxy(...,
handler)`. This preserves JavaScript accessor receiver semantics while still
rejecting arbitrary reflective reads.

`no-module-mocks-in-domain-tests` recognizes `vi.mock` and `vi.doMock` from
Vitest and Vite+ Test (`vite-plus/test`). Apply it only to a consumer's domain
test globs through standard overrides. For a test runner that exposes globals,
pass its permitted names through `globalBindings` (for example `['vi']`), so
ordinary local bindings remain excluded. `no-placeholder-symbol-names` requires
an exact `names` denylist for declarations and non-computed class or type
members; it never rejects a domain name merely because it contains a
discouraged word.

`no-unmanaged-pglite` rejects direct construction of `PGlite` imported from
`@electric-sql/pglite` or one of its subpaths, including namespace and dynamic
imports. It also rejects calls to imported `createDb`, whether reached through
`@wystack/db` or a relative import inside the database package. Named and
namespace imports receive the same lifecycle enforcement for `createDb`, the
test factories, and `useTestPglite`.
Apply it to test and fixture globs where instances must use `createTestPg` or
`createTestDb` from `@wystack/db/testing` for lifecycle management. Unrelated
local classes and functions with the same names are not affected. Files that
import either test factory must also call `useTestPglite()` at module scope;
importing the helper alone does not register Bun lifecycle hooks for that file.
Shared fixture modules must never call it at module scope because the hook would
attach only to the first importer. They should expose a composed `use...()`
function for each importing test file to call instead.

See [the rule roadmap](./ROADMAP.md) for the deliberately deferred rules that
need richer analysis than an AST-only plugin can provide safely.
