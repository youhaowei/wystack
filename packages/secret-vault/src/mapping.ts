// MappingStore — persisted binding: SecretRef → { backend, locator }
//
// The mapping is the ONLY place that knows which backend holds a given ref.
// Read-time resolution always starts here (never from the registry policy).
// The persistence seam is an interface; only the in-memory impl ships in this
// package — real persistence backends (SQLite, Electron safe-storage, etc.)
// are separate tickets.

import type { SecretRef } from './ref'

/** The record stored per ref: names the backend and its opaque locator. */
export interface MappingRecord {
  /** The name the backend was registered under in the SecretRegistry. */
  readonly backend: string
  /**
   * Backend-internal opaque identifier. Returned by `SecretBackend.store()`.
   * Meaningless outside that backend.
   */
  readonly locator: string
}

/**
 * Persistence seam for the ref → backend/locator binding.
 * Implementors MUST be synchronous-or-async — the interface is async to
 * accommodate future SQLite/IPC-backed implementations.
 */
export interface MappingStore {
  get(ref: SecretRef): Promise<MappingRecord | undefined>
  set(ref: SecretRef, record: MappingRecord): Promise<void>
  delete(ref: SecretRef): Promise<void>
  has(ref: SecretRef): Promise<boolean>
}

/**
 * In-memory {@link MappingStore} — for CI / dev / test backends.
 * Not encrypted, not persistent. Suitable as the default test double.
 */
export class InMemoryMappingStore implements MappingStore {
  readonly #store = new Map<SecretRef, MappingRecord>()

  async get(ref: SecretRef): Promise<MappingRecord | undefined> {
    // Copy-on-boundary: never hand out the stored reference. A caller that
    // mutates a fetched record must not corrupt the persisted binding. This
    // is the reference impl every backing store models, so the invariant
    // must hold here.
    const record = this.#store.get(ref)
    return record ? { ...record } : undefined
  }

  async set(ref: SecretRef, record: MappingRecord): Promise<void> {
    // Copy-on-boundary: store our own copy so later mutation of the caller's
    // object cannot reach into the store.
    this.#store.set(ref, { ...record })
  }

  async delete(ref: SecretRef): Promise<void> {
    this.#store.delete(ref)
  }

  async has(ref: SecretRef): Promise<boolean> {
    return this.#store.has(ref)
  }
}
