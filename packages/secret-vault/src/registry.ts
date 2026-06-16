// SecretRegistry — backend registration and store-time policy routing.
//
// Two distinct selection paths (MUST remain separate):
//
//   STORE-TIME  (policy):  pick the backend for a new secret based on its
//                          CredentialClass default + a runtime fallback.
//                          Lives here in the registry.
//
//   READ-TIME   (mapping): resolve an existing secret by reading its mapping
//                          record (which backend name was recorded at store
//                          time), then looking THAT backend up by name.
//                          Does NOT consult class-default policy.
//                          Lives in SecretVault, not here.
//
// This separation is load-bearing: changing store-time defaults MUST NOT
// affect the resolution of already-stored secrets.

import type { SecretBackend } from './backend'
import type { CredentialClass } from './class'

export class SecretRegistry {
  readonly #backends = new Map<string, SecretBackend>()
  readonly #classDefaults = new Map<CredentialClass, string>()
  #fallbackDefault: string | undefined

  /**
   * Register a backend under `name`. A backend registered as `fallback`
   * becomes the runtime fallback for any class that has no explicit default.
   *
   * @param name     - Stable identifier (written into mapping records — do NOT
   *                   change once secrets are stored under it).
   * @param backend  - The backend implementation.
   * @param opts.fallback - Make this the registry-wide fallback default.
   */
  register(name: string, backend: SecretBackend, opts: { fallback?: boolean } = {}): void {
    this.#backends.set(name, backend)
    if (opts.fallback) {
      this.#fallbackDefault = name
    }
  }

  /**
   * Set the default backend for `credentialClass` store-time routing.
   * The `name` must already be registered (or registered before first use).
   */
  setClassDefault(credentialClass: CredentialClass, name: string): void {
    this.#classDefaults.set(credentialClass, name)
  }

  /**
   * Resolve a backend by name (used at READ-TIME from the mapping record).
   * Throws if the named backend is not registered.
   */
  getByName(name: string): SecretBackend {
    const backend = this.#backends.get(name)
    if (!backend) {
      throw new Error(
        `[secret-vault] No backend registered under name "${name}". ` +
          `Registered: [${[...this.#backends.keys()].join(', ')}]`,
      )
    }
    return backend
  }

  /**
   * Resolve the backend to use for STORE-TIME routing of `credentialClass`.
   * Resolution order:
   *   1. Class-specific default (setClassDefault)
   *   2. Registry-wide fallback (register(..., { fallback: true }))
   *   3. Throws — no policy configured.
   */
  getForClass(credentialClass: CredentialClass): { name: string; backend: SecretBackend } {
    const name = this.#classDefaults.get(credentialClass) ?? this.#fallbackDefault
    if (!name) {
      throw new Error(
        `[secret-vault] No backend configured for class "${credentialClass}" ` +
          `and no fallback default is set.`,
      )
    }
    return { name, backend: this.getByName(name) }
  }

  /** Returns true if a backend is registered under `name`. */
  has(name: string): boolean {
    return this.#backends.has(name)
  }
}
