// SecretBackend — contract that concrete secret stores implement.
//
// The keychain backend and any future cloud/1Password backends implement this
// interface. Only the test backend ships in this package.
//
// Key design constraints:
//   - `has()` MUST NOT materialise the credential value. Provider metadata
//     operations are allowed when they cannot return secret fields. Implementations
//     must keep presence and credential-resolution paths structurally separate.
//   - `withSecret()` is a SCOPED LEASE. Plaintext exists only inside the `use`
//     callback unless trusted caller code deliberately captures or returns it.
//     The callback interface narrows accidental exposure; it is not a security
//     barrier against the caller. JS cannot zero strings after use.

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
   * Plaintext is handed only to the `use` callback. Trusted caller code can still
   * capture or return it, so this narrows accidental exposure rather than forming
   * a security barrier. JS cannot zero strings after the callback returns.
   *
   * @param locator - Opaque backend-internal locator (from `store()`).
   * @param use     - Callback that receives the plaintext for its duration.
   */
  withSecret<T>(locator: string, use: (plaintext: string) => Promise<T>): Promise<T>

  /**
   * Returns `true` if the locator is present in the backend.
   *
   * MUST NOT call a path that returns the credential value. A provider may return
   * decrypted item metadata (such as an ID, title, or tags) when that operation
   * cannot include secret fields. Keep this path separate from `withSecret()`.
   */
  has(locator: string): Promise<boolean>

  /**
   * Delete the secret at `locator` according to the provider's retention semantics.
   * Some providers may retain a recoverable copy (for example, in a trash bin).
   * Callers are responsible for also deleting the mapping record.
   */
  delete(locator: string): Promise<void>
}
