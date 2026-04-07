import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { findAvailablePort, writePortFile, readPortFile, removePortFile } from '../port'
import { join } from 'node:path'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'

describe('findAvailablePort', () => {
  test('returns a port number', async () => {
    const port = await findAvailablePort()
    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThanOrEqual(65535)
  })

  test('returns a different port when preferred is taken', async () => {
    // Occupy a port on 0.0.0.0 (same address isPortAvailable probes by default)
    const blocker = createServer()
    const occupied = await new Promise<number>((resolve) => {
      blocker.listen(0, '0.0.0.0', () => {
        const addr = blocker.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

    try {
      const port = await findAvailablePort({ preferred: occupied })
      expect(port).not.toBe(occupied)
      expect(port).toBeGreaterThan(0)
    } finally {
      blocker.close()
    }
  })

  test('returns preferred port when available', async () => {
    // Find a free port first, then request it as preferred
    const freePort = await findAvailablePort()
    const port = await findAvailablePort({ preferred: freePort })
    expect(port).toBe(freePort)
  })

  test('respects range option', async () => {
    const port = await findAvailablePort({ range: [9000, 9100] })
    expect(port).toBeGreaterThanOrEqual(9000)
    expect(port).toBeLessThanOrEqual(9100)
  })

  test('throws when no port available in tight range', async () => {
    // Occupy a single-port range on 0.0.0.0 (same address isPortAvailable probes by default)
    const blocker = createServer()
    const occupied = await new Promise<number>((resolve) => {
      blocker.listen(0, '0.0.0.0', () => {
        const addr = blocker.address()
        resolve(typeof addr === 'object' && addr ? addr.port : 0)
      })
    })

    try {
      await expect(findAvailablePort({ range: [occupied, occupied] })).rejects.toThrow()
    } finally {
      blocker.close()
    }
  })
})

describe('port file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wystack-port-test-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('writePortFile creates .wystack/port file', async () => {
    await writePortFile(3210, { dir })
    const portFile = join(dir, '.wystack', 'port')
    expect(existsSync(portFile)).toBe(true)
    expect(readFileSync(portFile, 'utf-8').trim()).toBe('3210')
  })

  test('readPortFile returns the port', async () => {
    await writePortFile(4567, { dir })
    const port = await readPortFile({ dir })
    expect(port).toBe(4567)
  })

  test('readPortFile returns null when no file exists', async () => {
    const port = await readPortFile({ dir })
    expect(port).toBeNull()
  })

  test('removePortFile cleans up', async () => {
    await writePortFile(3210, { dir })
    await removePortFile({ dir })
    const port = await readPortFile({ dir })
    expect(port).toBeNull()
  })

  test('writePortFile includes metadata', async () => {
    await writePortFile(3210, { dir })
    const metaFile = join(dir, '.wystack', 'runtime.json')
    expect(existsSync(metaFile)).toBe(true)
    const meta = JSON.parse(readFileSync(metaFile, 'utf-8'))
    expect(meta.port).toBe(3210)
    expect(meta.pid).toBe(process.pid)
    expect(typeof meta.startedAt).toBe('string')
  })
})
