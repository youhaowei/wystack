/**
 * Test-only Bun preload for measuring live PGlite instances across a package test run.
 *
 * Usage:
 * cd packages/<pkg> && INSTR_OUT=/tmp/probe.txt bun test --preload ../../scripts/pglite-instance-probe.ts src && cat /tmp/probe.txt
 *
 * Bun's process.on('exit') and process.on('beforeExit') do not fire under `bun test`,
 * so the probe writes counts after every construct and close instead of only at exit.
 * PGlite close() can be called after an instance is already closed, so the live count
 * only decrements when `closed` was false beforehand; otherwise it can go negative.
 */
import { writeFileSync } from 'node:fs'
import { mock } from 'bun:test'
import * as pglite from '@electric-sql/pglite'

const outputPath = process.env.INSTR_OUT

if (!outputPath) {
  throw new Error('INSTR_OUT must name the PGlite instance probe output file')
}

let created = 0
let live = 0
let peakLive = 0

function writeCounts(): void {
  writeFileSync(outputPath, `created=${created} peak_live=${peakLive} still_live=${live}\n`)
}

class CountingPGlite extends pglite.PGlite {
  constructor(...args: ConstructorParameters<typeof pglite.PGlite>) {
    super(...args)
    created += 1
    live += 1
    peakLive = Math.max(peakLive, live)
    writeCounts()
  }

  override async close(): Promise<void> {
    const wasClosed = this.closed
    await super.close()

    if (!wasClosed) {
      live -= 1
      writeCounts()
    }
  }
}

mock.module('@electric-sql/pglite', () => ({
  ...pglite,
  PGlite: CountingPGlite,
}))
