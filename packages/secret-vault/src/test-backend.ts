// TestBackend — in-memory SecretBackend for CI / dev use.
//
// NOT encrypted. Suitable only as a test double — do not use in production.
//
// The `has()` contract (never decrypt) is enforced STRUCTURALLY:
//   - Plaintext is stored in `#store` (Map keyed by locator).
//   - A parallel presence index `#presence` (Set) tracks known locators.
//   - `has()` reads ONLY `#presence` — it never touches `#store`.
//   - `withSecret()` reads ONLY `#store`.
// Tests can verify this by checking `resolveCallCount` vs `hasCallCount` on
// the instrumented accessors below (see acceptance tests).

import type { SecretBackend } from './backend'

export class TestBackend implements SecretBackend {
  /** Plaintext store — read ONLY in withSecret. */
  readonly #store = new Map<string, string>()

  /** Presence index — read ONLY in has(). Never contains plaintext. */
  readonly #presence = new Set<string>()

  /** Instrumentation: number of times withSecret resolved plaintext. */
  resolveCallCount = 0

  /** Instrumentation: number of times has() was called. */
  hasCallCount = 0

  async store(plaintext: string, locatorHint?: string): Promise<string> {
    const locator = locatorHint
      ? `test:${locatorHint}:${crypto.randomUUID()}`
      : `test:${crypto.randomUUID()}`
    this.#store.set(locator, plaintext)
    this.#presence.add(locator)
    return locator
  }

  async withSecret<T>(locator: string, use: (plaintext: string) => Promise<T>): Promise<T> {
    const plaintext = this.#store.get(locator)
    if (plaintext === undefined) {
      throw new Error(`[test-backend] No secret at locator "${locator}"`)
    }
    this.resolveCallCount++
    return use(plaintext)
  }

  /** MUST NOT decrypt — reads only the presence index, never #store. */
  async has(locator: string): Promise<boolean> {
    this.hasCallCount++
    return this.#presence.has(locator)
  }

  async delete(locator: string): Promise<void> {
    this.#store.delete(locator)
    this.#presence.delete(locator)
  }
}
