// Registry unit tests — store-time routing policy.

import { describe, test, expect } from 'bun:test'
import { SecretRegistry } from '../registry'
import { TestBackend } from '../test-backend'

describe('SecretRegistry', () => {
  test('register makes a backend available by name', () => {
    const registry = new SecretRegistry()
    const b = new TestBackend()
    registry.register('my-backend', b)
    expect(registry.has('my-backend')).toBe(true)
  })

  test('getByName returns the registered backend', () => {
    const registry = new SecretRegistry()
    const b = new TestBackend()
    registry.register('b', b)
    expect(registry.getByName('b')).toBe(b)
  })

  test('getByName throws for unregistered name', () => {
    const registry = new SecretRegistry()
    expect(() => registry.getByName('missing')).toThrow(/missing/)
  })

  test('getForClass returns class-specific default', () => {
    const registry = new SecretRegistry()
    const b = new TestBackend()
    registry.register('connector-store', b)
    registry.setClassDefault('connector-key', 'connector-store')
    const { name } = registry.getForClass('connector-key')
    expect(name).toBe('connector-store')
  })

  test('getForClass falls back to the fallback backend when no class default', () => {
    const registry = new SecretRegistry()
    const fallback = new TestBackend()
    registry.register('fallback', fallback, { fallback: true })
    const { name, backend } = registry.getForClass('serve-token')
    expect(name).toBe('fallback')
    expect(backend).toBe(fallback)
  })

  test('class default takes precedence over fallback', () => {
    const registry = new SecretRegistry()
    const specific = new TestBackend()
    const fallback = new TestBackend()
    registry.register('specific', specific)
    registry.register('fallback', fallback, { fallback: true })
    registry.setClassDefault('connector-key', 'specific')
    const { name } = registry.getForClass('connector-key')
    expect(name).toBe('specific')
  })

  test('getForClass throws when no class default and no fallback', () => {
    const registry = new SecretRegistry()
    expect(() => registry.getForClass('connector-key')).toThrow(/connector-key/)
  })
})
