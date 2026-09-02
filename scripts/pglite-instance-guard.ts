/**
 * Test-only Bun preload that enforces and optionally measures live PGlite instances.
 *
 * Usage:
 * cd packages/<pkg> && INSTR_OUT=/tmp/probe.txt bun test --preload ../../scripts/pglite-instance-guard.ts src && cat /tmp/probe.txt
 *
 * Bun's process.on('exit') and process.on('beforeExit') do not fire under `bun test`,
 * so optional probe counts are written after every construct and close instead of at exit.
 * PGlite close() can be called after an instance is already closed, so the live count
 * only decrements when `closed` was false beforehand; otherwise it can go negative.
 */
import { writeFileSync } from 'node:fs'
import { mock } from 'bun:test'
import * as pglite from '@electric-sql/pglite'

// Measured peaks are server 2, client 2, and db 1 here, versus server 98 at base
// d0cf624. Eight leaves room for tests that legitimately open several databases
// together while still catching unbounded growth; it is a leak ceiling, not a target.
const MAX_LIVE_PGLITE_INSTANCES = 8

const outputPath = process.env.INSTR_OUT
let created = 0
let live = 0
let peakLive = 0
let reportedBoundBreach = false

function writeCounts(): void {
  if (outputPath) {
    writeFileSync(outputPath, `created=${created} peak_live=${peakLive} still_live=${live}\n`)
  }
}

function constructionTestFile(stack: string | undefined): string | undefined {
  return stack
    ?.split('\n')
    .slice(1)
    .filter(
      (frame) =>
        !frame.includes('pglite-instance-guard.ts') &&
        !frame.includes('node_modules') &&
        !frame.includes('packages/db/src/testing.ts'),
    )
    .find(
      (frame) =>
        frame.includes('/__tests__/') ||
        /\.(?:test|fixture)\.[cm]?[jt]sx?(?::\d+){0,2}[)]?$/.test(frame),
    )
    ?.trim()
}

class CountingPGlite extends pglite.PGlite {
  private countedAsLive = false

  constructor(...args: ConstructorParameters<typeof pglite.PGlite>) {
    super(...args)
    created += 1
    live += 1
    this.countedAsLive = true
    peakLive = Math.max(peakLive, live)
    writeCounts()

    if (live > MAX_LIVE_PGLITE_INSTANCES) {
      const countAtBreach = live
      const testFile = constructionTestFile(new Error().stack)
      this.removeFromLiveCount()
      void this.close().catch(() => {})

      // The first accurate failure already makes the suite red; suppress later
      // breaches so the guard cannot cascade into unrelated, misattributed errors.
      if (reportedBoundBreach) {
        return
      }

      reportedBoundBreach = true
      throw new Error(
        `PGlite live instance bound exceeded in ${testFile ?? 'an unknown test file (no eligible construction frame found)'}: current count ${countAtBreach}, bound ${MAX_LIVE_PGLITE_INSTANCES}`,
      )
    }
  }

  private removeFromLiveCount(): void {
    if (this.countedAsLive) {
      this.countedAsLive = false
      live -= 1
      writeCounts()
    }
  }

  override async close(): Promise<void> {
    const wasClosed = this.closed
    await super.close()

    if (!wasClosed) {
      this.removeFromLiveCount()
    }
  }
}

mock.module('@electric-sql/pglite', () => ({
  ...pglite,
  PGlite: CountingPGlite,
}))
