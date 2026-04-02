/**
 * Runtime environment detection.
 *
 * Detects whether we're running in Bun, Node, Electron, Deno, or unknown.
 * Used to select the right server adapter and adjust behavior.
 */

export type Runtime = 'bun' | 'node' | 'electron' | 'deno' | 'unknown'

/** Detect the current JavaScript runtime. */
export function detectRuntime(): Runtime {
  const g = globalThis as Record<string, unknown>

  // Bun — check first since Bun also has `process.versions.node`
  if (typeof g.Bun !== 'undefined') return 'bun'

  // Deno
  if (typeof g.Deno !== 'undefined') return 'deno'

  // Electron — has `process.versions.electron`
  if (
    typeof process !== 'undefined' &&
    process.versions &&
    'electron' in process.versions
  ) {
    return 'electron'
  }

  // Node.js
  if (
    typeof process !== 'undefined' &&
    process.versions &&
    'node' in process.versions
  ) {
    return 'node'
  }

  return 'unknown'
}
