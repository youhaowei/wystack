// @wystack/secret-vault
//
// Secret vault substrate — the credential boundary both the control plane and
// the data plane depend on. Provides an opaque SecretRef (auth-blind stable
// id), a SecretBackend contract, a backend registry with class-based
// store-time routing, a mapping store (ref → backend+locator), and a
// SecretVault composition surface.
//
// No real backends ship here — keychain (YW-262) and cloud backends are
// separate packages. The TestBackend is the in-memory double for CI/dev.
//
// Public surface — consumers import from "@wystack/secret-vault", not from
// the internal modules.

// Ref
export type { SecretRef } from './ref'
export { makeSecretRef, isSecretRef } from './ref'

// CredentialClass
export type { CredentialClass } from './class'

// Mapping store
export type { MappingRecord, MappingStore } from './mapping'
export { InMemoryMappingStore } from './mapping'

// Backend contract
export type { SecretBackend } from './backend'

// Registry
export { SecretRegistry } from './registry'

// Vault
export { SecretVault } from './vault'

// Test backend (in-memory, unencrypted — CI/dev only)
export { TestBackend } from './test-backend'
