// SecretBackend — contract that concrete secret stores implement.
//
// YW-262 (keychain) and any future cloud/1Password backends implement this
// interface. Only the test backend ships in this package.
//
// Key design constraints:
//   - `has()` MUST NOT decrypt. Presence checks flow from this — they must
//     not trigger any HSM/keychain/network operation that materialises
//     plaintext. Implementations must enforce this structurally.
//   - `withSecret()` is a SCOPED LEASE. Plaintext exists only inside the `use`
//     callback. The type signature prevents returning plaintext out of the
//     callback — `use` receives `string` but `withSecret` returns
//     `Promise<T>`, and T is inferred from the callback's return type.
//     JS cannot zero strings, so "the lease is structural, not memory-wipe"
//     must be documented here rather than enforced at runtime.

/**
 * Contract for a concrete secret storage backend.
 *
 * @typeParam T - Type returned by the `use` callback in `withSecret`.
 */
export interface SecretBackend {
  /**
   * Encrypt and persist `plaintext`. Returns an opaque backend-internal
   * `locator` that the {@link MappingStore} will record.
   *
   * @param plaintext    - The secret to store.
   * @param locatorHint  - Optional human-readable hint (e.g. "github-api-key").
   *                       Backends may use it to name keychain entries.
   *                       Ignored if the backend doesn't support hints.
   * @returns An opaque locator string meaningful only to this backend.
   */
  store(plaintext: string, locatorHint?: string): Promise<string>

  /**
   * Resolve a locator and call `use` with the plaintext.
   *
   * Plaintext exists ONLY inside the `use` callback — this is a scoped lease.
   * The type signature enforces this: `use` is the only place plaintext is
   * visible; the return type `Promise<T>` carries only whatever `use` returns.
   * JS cannot zero strings after the callback returns, so "scoped" means
   * "structurally un-returnable" not "memory-wiped".
   *
   * @param locator - Opaque backend-internal locator (from `store()`).
   * @param use     - Callback that receives the plaintext for its duration.
   */
  withSecret<T>(locator: string, use: (plaintext: string) => Promise<T>): Promise<T>

  /**
   * Returns `true` if the locator is present in the backend.
   *
   * MUST NOT decrypt. MUST NOT call any path that materialises plaintext.
   * Implementations should maintain a separate presence index rather than
   * resolving through the decryption path.
   */
  has(locator: string): Promise<boolean>

  /**
   * Permanently delete the secret at `locator`.
   * Callers are responsible for also deleting the mapping record.
   */
  delete(locator: string): Promise<void>
}
