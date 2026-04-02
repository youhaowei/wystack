import { describe, test, expect } from 'bun:test'
import { detectRuntime, type Runtime } from '../env'

describe('detectRuntime', () => {
  test('detects current runtime', () => {
    const runtime = detectRuntime()
    // We're running in Bun
    expect(runtime).toBe('bun')
  })

  test('returns a valid Runtime type', () => {
    const runtime = detectRuntime()
    const valid: Runtime[] = ['bun', 'node', 'electron', 'deno', 'unknown']
    expect(valid).toContain(runtime)
  })
})
