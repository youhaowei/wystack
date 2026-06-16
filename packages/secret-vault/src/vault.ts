// SecretVault — the public composition surface.
//
// Wires registry + mapping + backends into the four operations exposed
// to consumers: store / withSecret / has / delete.
//
// Auth-blind: the vault does not know which user or session is requesting a
// secret. Access control is the responsibility of the layer above (the
// connector factory / capability attenuator). The vault is a pure
// credential-boundary substrate.
//
// No list(). No rotate() — rotation composes as delete()+store().

import type { CredentialClass } from './class'
import type { MappingStore } from './mapping'
import type { SecretRef } from './ref'
import { makeSecretRef } from './ref'
import type { SecretRegistry } from './registry'

export class SecretVault {
  readonly #registry: SecretRegistry
  readonly #mapping: MappingStore

  constructor(registry: SecretRegistry, mapping: MappingStore) {
    this.#registry = registry
    this.#mapping = mapping
  }

  /**
   * Store a new secret.
   *
   * 1. Pick the backend via store-time class policy (registry).
   * 2. Write the plaintext to the backend; receive a locator.
   * 3. Mint a fresh {@link SecretRef}.
   * 4. Write `ref → { backend, locator }` to the mapping store.
   * 5. Return the ref — the only stable handle to the secret.
   */
  async store(
    plaintext: string,
    opts: { class: CredentialClass; locatorHint?: string },
  ): Promise<SecretRef> {
    const { name, backend } = this.#registry.getForClass(opts.class)
    const locator = await backend.store(plaintext, opts.locatorHint)
    const ref = makeSecretRef()
    try {
      await this.#mapping.set(ref, { backend: name, locator })
    } catch (err) {
      // The plaintext is already in the backend but the ref→locator binding
      // never persisted, so SecretVault.delete() can never reach it. Roll the
      // backend write back best-effort to avoid orphaning a live credential.
      // (The in-memory mapping never throws; persistent stores — SQLite/IPC —
      // can.) A failed rollback is swallowed: the original mapping error is
      // the one the caller must see.
      try {
        await backend.delete(locator)
      } catch {
        // best-effort — surface the original mapping failure below
      }
      throw err
    }
    return ref
  }

  /**
   * Resolve a secret and call `use` with the plaintext — SCOPED LEASE.
   *
   * Plaintext exists only inside the `use` callback. The type signature
   * prevents returning plaintext out: `use` receives `string` but
   * `withSecret` returns `Promise<T>` (whatever `use` returns).
   * JS cannot zero strings — "scoped" means "structurally un-returnable."
   *
   * Read-time routing: reads the mapping record (backend name + locator),
   * then looks up THAT backend by name. The store-time class policy is NOT
   * consulted — changing defaults after store does not affect resolution.
   */
  async withSecret<T>(ref: SecretRef, use: (plaintext: string) => Promise<T>): Promise<T> {
    const record = await this.#mapping.get(ref)
    if (!record) {
      throw new Error(`[secret-vault] No mapping found for ref "${ref}"`)
    }
    const backend = this.#registry.getByName(record.backend)
    return backend.withSecret(record.locator, use)
  }

  /**
   * Check whether the secret is present — MUST NOT decrypt.
   *
   * Reads the mapping store first (presence check), then asks the backend
   * `has(locator)` — which is also a non-decrypting presence check.
   * Never calls `withSecret` or any path that materialises plaintext.
   */
  async has(ref: SecretRef): Promise<boolean> {
    const record = await this.#mapping.get(ref)
    if (!record) return false
    const backend = this.#registry.getByName(record.backend)
    return backend.has(record.locator)
  }

  /**
   * Permanently delete the secret.
   * Removes from the backend AND the mapping store.
   * After this call, `has(ref)` returns false and `withSecret(ref, …)` throws.
   */
  async delete(ref: SecretRef): Promise<void> {
    const record = await this.#mapping.get(ref)
    if (!record) return
    const backend = this.#registry.getByName(record.backend)
    await backend.delete(record.locator)
    await this.#mapping.delete(ref)
  }
}
