# Rule roadmap

These rules are deferred because a syntax-only Oxlint plugin cannot distinguish
the safe patterns from the defect reliably. They are not implemented as stubs.

| Rule                                     | Defect target                                                       | Allowed patterns and acceptance fixture                                                                                               | Required analysis                                               | Ready when                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `no-ad-hoc-boundary-validation`          | Repeated, inconsistent parsing of untrusted input across a boundary | A named parser or schema validates a value once; fixture covers valid and malformed input                                             | Interprocedural call graph plus type-flow from boundary sources | The analyzer can trace a boundary value to its validator without flagging local type guards            |
| `no-forwarded-unknown`                   | `unknown` crosses a public boundary without ownership or validation | A public function returns a named opaque/domain type, or narrows before forwarding; fixture includes JSON and heterogeneous-row seams | Type-aware public API and return-flow analysis                  | The analyzer distinguishes deliberate generic/JSON APIs from unowned forwarding                        |
| `require-unsafe-assertion-justification` | Unsafe narrowing or double assertions lack a local invariant        | A runtime guard, schema parse, or explicit justification accompanies the assertion; fixture covers each alternative                   | Type-aware assertion safety and control-flow dominance          | The analyzer can prove a guard dominates an assertion and require prose only for the remaining escapes |

Optional-property semantics are intentionally not a lint rule. Consumers should
enable TypeScript's `exactOptionalPropertyTypes` compiler option, which enforces
the distinction at the type-system boundary.
