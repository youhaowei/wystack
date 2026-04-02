/**
 * Port discovery — find available ports and manage port files.
 *
 * Port files let tooling (CLI, dev tools, Electron main process) discover
 * a running WyStack server without hardcoding ports.
 *
 * Layout:
 *   {dir}/.wystack/port          — plain text port number
 *   {dir}/.wystack/runtime.json  — full metadata (port, pid, startedAt)
 */

import { createServer } from 'node:net'
import { join } from 'node:path'
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'

export interface FindPortOptions {
  /** Preferred port to try first. Falls back to scanning if taken. */
  preferred?: number
  /** Port range to scan [min, max]. Default: [3000, 3999]. */
  range?: [min: number, max: number]
}

/** Try to bind to a port and immediately release it. Returns true if available. */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

/**
 * Find an available port.
 *
 * Strategy:
 * 1. Try the preferred port (if given)
 * 2. Scan the range sequentially
 * 3. Fall back to OS-assigned port (port 0)
 */
export async function findAvailablePort(opts: FindPortOptions = {}): Promise<number> {
  const { preferred, range } = opts
  const [min, max] = range ?? [3000, 3999]

  // Try preferred first
  if (preferred !== undefined) {
    if (await isPortAvailable(preferred)) return preferred
    // If we have a range constraint and preferred is outside it, don't fall through
  }

  // Scan range
  for (let port = min; port <= max; port++) {
    if (await isPortAvailable(port)) return port
  }

  // If range was explicitly set and exhausted, that's an error
  if (range) {
    throw new Error(
      `No available port in range ${min}-${max}. ` +
      `All ${max - min + 1} ports are in use.`
    )
  }

  // Final fallback: let the OS pick
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('Failed to find an available port'))
      })
    })
    server.once('error', reject)
  })
}

// --- Port file management ---

interface PortFileOptions {
  /** Project root directory. Port file is written to {dir}/.wystack/port */
  dir: string
}

const WYSTACK_DIR = '.wystack'

function portFilePath(dir: string): string {
  return join(dir, WYSTACK_DIR, 'port')
}

function metadataFilePath(dir: string): string {
  return join(dir, WYSTACK_DIR, 'runtime.json')
}

/** Write a port file so other processes can discover this server. */
export async function writePortFile(port: number, opts: PortFileOptions): Promise<void> {
  const wystackDir = join(opts.dir, WYSTACK_DIR)
  await mkdir(wystackDir, { recursive: true })

  // Write plain port file (easy to read from shell scripts)
  await writeFile(portFilePath(opts.dir), String(port) + '\n')

  // Write metadata file (for tooling)
  const metadata = {
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }
  await writeFile(metadataFilePath(opts.dir), JSON.stringify(metadata, null, 2) + '\n')
}

/** Read the port from a port file. Returns null if no port file exists. */
export async function readPortFile(opts: PortFileOptions): Promise<number | null> {
  const path = portFilePath(opts.dir)
  if (!existsSync(path)) return null

  try {
    const content = await readFile(path, 'utf-8')
    const port = parseInt(content.trim(), 10)
    return Number.isFinite(port) ? port : null
  } catch {
    return null
  }
}

/** Remove the port file and metadata. Call on shutdown. */
export async function removePortFile(opts: PortFileOptions): Promise<void> {
  const path = portFilePath(opts.dir)
  const metaPath = metadataFilePath(opts.dir)

  await rm(path, { force: true })
  await rm(metaPath, { force: true })
}
