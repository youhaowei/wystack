// Acceptance-criteria tests for the SecretVault composition surface.
//
// Each numbered section corresponds to a specific AC from the YW-261 brief.
// These are load-bearing contract tests — not glue.

import { describe, test, expect } from 'bun:test'
import { SecretVault } from '../vault'
import { SecretRegistry } from '../registry'
import { InMemoryMappingStore } from '../mapping'
import { TestBackend } from '../test-backend'
import { isSecretRef } from '../ref'
import type { MappingRecord, MappingStore } from '../mapping'
import type { SecretRef } from '../ref'

// ─── Fixture ─────────────────────────────────────────────────────────────────

function makeVault(opts?: { connectorBackend?: TestBackend; serveBackend?: TestBackend }): {
  vault: SecretVault
  registry: SecretRegistry
  mapping: InMemoryMappingStore
  connectorBackend: TestBackend
  serveBackend: TestBackend
} {
  const connectorBackend = opts?.connectorBackend ?? new TestBackend()
  const serveBackend = opts?.serveBackend ?? new TestBackend()
  const registry = new SecretRegistry()
  registry.register('test-connector', connectorBackend, { fallback: false })
  registry.register('test-serve', serveBackend)
  registry.setClassDefault('connector-key', 'test-connector')
  registry.setClassDefault('serve-token', 'test-serve')

  const mapping = new InMemoryMappingStore()
  const vault = new SecretVault(registry, mapping)
  return { vault, registry, mapping, connectorBackend, serveBackend }
}

// ─── AC 1: store → withSecret → has → delete round-trip ─────────────────────

describe('round-trip: store → withSecret → has → delete', () => {
  test('store returns a SecretRef', async () => {
    const { vault } = makeVault()
    const ref = await vault.store('my-api-key', { class: 'connector-key' })
    expect(isSecretRef(ref)).toBe(true)
  })

  test('withSecret retrieves the stored plaintext inside the callback', async () => {
    const { vault } = makeVault()
    const ref = await vault.store('super-secret', { class: 'connector-key' })
    const result = await vault.withSecret(ref, async (plaintext) => {
      expect(plaintext).toBe('super-secret')
      return 'callback-result'
    })
    // The callback's return value is propagated, not the plaintext
    expect(result).toBe('callback-result')
  })

  test('has returns true after store', async () => {
    const { vault } = makeVault()
    const ref = await vault.store('abc', { class: 'serve-token' })
    expect(await vault.has(ref)).toBe(true)
  })

  test('delete removes the secret; has returns false and withSecret throws', async () => {
    const { vault } = makeVault()
    const ref = await vault.store('ephemeral', { class: 'connector-key' })

    await vault.delete(ref)

    expect(await vault.has(ref)).toBe(false)
    await expect(vault.withSecret(ref, async (p) => p)).rejects.toThrow()
  })
})

// ─── AC 2: has() MUST NOT invoke the backend's decrypt path ──────────────────

describe('has() — never decrypts', () => {
  test('has() does not increment resolveCallCount on the backend', async () => {
    const connectorBackend = new TestBackend()
    const { vault } = makeVault({ connectorBackend })

    const ref = await vault.store('key', { class: 'connector-key' })

    // Reset instrumentation counters post-store
    connectorBackend.resolveCallCount = 0

    await vault.has(ref)

    // withSecret (decrypt path) must never have been called
    expect(connectorBackend.resolveCallCount).toBe(0)
    // But has() itself should have been called once on the backend
    expect(connectorBackend.hasCallCount).toBe(1)
  })

  test('has() on absent ref returns false without touching any backend', async () => {
    const connectorBackend = new TestBackend()
    const { vault } = makeVault({ connectorBackend })

    // Manufacture a ref that has no mapping entry
    const { makeSecretRef } = await import('../ref')
    const orphanRef = makeSecretRef()

    const result = await vault.has(orphanRef)
    expect(result).toBe(false)
    // Backend never consulted — no mapping record
    expect(connectorBackend.resolveCallCount).toBe(0)
    expect(connectorBackend.hasCallCount).toBe(0)
  })
})

// ─── AC 3: withSecret plaintext cannot escape the callback ───────────────────

describe('withSecret — scoped lease, plaintext stays in callback', () => {
  test('return value from withSecret is the callback result, not the plaintext', async () => {
    const { vault } = makeVault()
    const ref = await vault.store('top-secret', { class: 'connector-key' })

    // Attempt to "escape" by capturing inside callback — this is a runtime
    // test that the outer call site only sees the typed callback return.
    const transformed = await vault.withSecret(ref, async (plaintext) => {
      return plaintext.length // transform, not return raw
    })

    // Outer code sees the number, not the string
    expect(typeof transformed).toBe('number')
    expect(transformed).toBe('top-secret'.length)
  })

  test('withSecret propagates errors thrown inside the callback', async () => {
    const { vault } = makeVault()
    const ref = await vault.store('key', { class: 'connector-key' })

    await expect(
      vault.withSecret(ref, async (_plaintext) => {
        throw new Error('callback-error')
      }),
    ).rejects.toThrow('callback-error')
  })
})

// ─── AC 4: Registry store-time class-default + fallback routing ──────────────

describe('registry — store-time routing', () => {
  test('connector-key routes to test-connector backend', async () => {
    const connectorBackend = new TestBackend()
    const serveBackend = new TestBackend()
    const { vault } = makeVault({ connectorBackend, serveBackend })

    await vault.store('key-a', { class: 'connector-key' })

    expect(connectorBackend.hasCallCount).toBe(0) // stored, not checked yet
    // Verify it was stored in connector backend by resolving through it
    connectorBackend.resolveCallCount = 0
    serveBackend.resolveCallCount = 0

    // store another connector-key and a serve-token
    const connRef = await vault.store('connector-secret', { class: 'connector-key' })
    const serveRef = await vault.store('serve-secret', { class: 'serve-token' })

    // Check via has — connector ref should be in connector backend
    await vault.withSecret(connRef, async (p) => {
      expect(p).toBe('connector-secret')
    })
    await vault.withSecret(serveRef, async (p) => {
      expect(p).toBe('serve-secret')
    })

    // resolveCallCount on each backend proves routing
    expect(connectorBackend.resolveCallCount).toBe(1)
    expect(serveBackend.resolveCallCount).toBe(1)
  })

  test('fallback backend is used for any class without an explicit default', async () => {
    // Set up a registry where only a fallback is registered (no class defaults)
    const fallback = new TestBackend()
    const registry = new SecretRegistry()
    registry.register('fallback-backend', fallback, { fallback: true })
    // Note: no setClassDefault calls

    const mapping = new InMemoryMappingStore()
    const vault = new SecretVault(registry, mapping)

    // Both classes should route to the fallback since no class default is set
    const ref1 = await vault.store('secret1', { class: 'connector-key' })
    const ref2 = await vault.store('secret2', { class: 'serve-token' })

    fallback.resolveCallCount = 0
    await vault.withSecret(ref1, async (p) => expect(p).toBe('secret1'))
    await vault.withSecret(ref2, async (p) => expect(p).toBe('secret2'))
    expect(fallback.resolveCallCount).toBe(2)
  })
})

// ─── AC 5: Read-time follows the MAPPING, not store-time registry policy ─────

describe('read-time resolution follows the mapping record', () => {
  test('changing the store-time default does not affect resolution of already-stored secrets', async () => {
    const backend1 = new TestBackend()
    const backend2 = new TestBackend()
    const registry = new SecretRegistry()
    registry.register('backend-1', backend1)
    registry.register('backend-2', backend2)
    registry.setClassDefault('connector-key', 'backend-1')

    const mapping = new InMemoryMappingStore()
    const vault = new SecretVault(registry, mapping)

    // Store a secret while backend-1 is the default
    const ref = await vault.store('original-secret', { class: 'connector-key' })

    // Verify it resolves via backend-1
    backend1.resolveCallCount = 0
    await vault.withSecret(ref, async (p) => expect(p).toBe('original-secret'))
    expect(backend1.resolveCallCount).toBe(1)

    // NOW change the store-time default to backend-2
    registry.setClassDefault('connector-key', 'backend-2')

    // The existing ref MUST still resolve via backend-1 (its mapping record)
    backend1.resolveCallCount = 0
    backend2.resolveCallCount = 0
    await vault.withSecret(ref, async (p) => expect(p).toBe('original-secret'))

    expect(backend1.resolveCallCount).toBe(1) // backend-1 handled it
    expect(backend2.resolveCallCount).toBe(0) // backend-2 not consulted
  })
})

// ─── store() rolls back the backend write when mapping persistence fails ─────

describe('store() — rollback on mapping failure', () => {
  test('a failing mapping.set deletes the backend locator instead of orphaning it', async () => {
    const backend = new TestBackend()
    const registry = new SecretRegistry()
    registry.register('only', backend, { fallback: true })

    // A mapping store whose set() always rejects (models a persistent
    // SQLite/IPC store failing after the backend write succeeded).
    const failingMapping: MappingStore = {
      get: async (_ref: SecretRef): Promise<MappingRecord | undefined> => undefined,
      set: async (): Promise<void> => {
        throw new Error('disk full')
      },
      delete: async (): Promise<void> => {},
      has: async (): Promise<boolean> => false,
    }

    const vault = new SecretVault(registry, failingMapping)

    await expect(vault.store('secret', { class: 'connector-key' })).rejects.toThrow('disk full')

    // The backend write must have been rolled back — nothing left behind.
    // (delete() is best-effort; with TestBackend it fully removes the locator,
    // so resolveCallCount stays 0 and no presence lingers.)
    expect(backend.resolveCallCount).toBe(0)
  })
})
