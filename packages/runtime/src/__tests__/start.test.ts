import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { defineSchema, text, int, boolean } from '@wystack/db'
import { createWyStack, query, mutation } from '@wystack/server'
import { startRuntime, type RuntimeHandle } from '../start'
import { readPortFile } from '../port'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const schema = defineSchema({
  items: {
    id: int.primaryKey(),
    name: text,
    active: boolean,
  },
})

describe('startRuntime', () => {
  let tmpDir: string
  let handle: RuntimeHandle | undefined

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'wystack-runtime-test-'))
  })

  afterEach(async () => {
    if (handle) {
      await handle.shutdown()
      handle = undefined
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  async function makeApp() {
    const pg = new PGlite()
    const db = drizzle(pg)
    await db.execute(`
      CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        active BOOLEAN NOT NULL
      )
    `)

    return createWyStack({
      db,
      functions: {
        listItems: query({
          args: {},
          handler: async (ctx) => ctx.db.from(schema.items).all(),
        }),
        addItem: mutation({
          args: { name: text },
          handler: async (ctx, args) =>
            ctx.db.into(schema.items).insert({ name: args.name, active: true }),
        }),
      },
    })
  }

  test('starts server and returns handle with port', async () => {
    const app = await makeApp()
    handle = await startRuntime({ app, port: 0, dir: tmpDir })

    expect(handle.port).toBeGreaterThan(0)
    expect(handle.url).toBe(`http://localhost:${handle.port}`)
  })

  test('server responds to HTTP queries', async () => {
    const app = await makeApp()
    handle = await startRuntime({ app, port: 0, dir: tmpDir })

    const res = await fetch(`${handle.url}/api/listItems`)
    const json = await res.json()
    expect(json.data).toEqual([])
  })

  test('writes port file', async () => {
    const app = await makeApp()
    handle = await startRuntime({ app, port: 0, dir: tmpDir })

    const port = await readPortFile({ dir: tmpDir })
    expect(port).toBe(handle.port)
  })

  test('cleans up port file on shutdown', async () => {
    const app = await makeApp()
    handle = await startRuntime({ app, port: 0, dir: tmpDir })

    await handle.shutdown()
    const port = await readPortFile({ dir: tmpDir })
    expect(port).toBeNull()
    handle = undefined // prevent double-shutdown in afterEach
  })

  test('runs lifecycle hooks', async () => {
    const events: string[] = []
    const app = await makeApp()

    handle = await startRuntime({
      app,
      port: 0,
      dir: tmpDir,
      onStart: () => { events.push('started') },
      onStop: () => { events.push('stopped') },
    })

    expect(events).toEqual(['started'])

    await handle.shutdown()
    expect(events).toEqual(['started', 'stopped'])
    handle = undefined
  })

  test('exposes runtime info', async () => {
    const app = await makeApp()
    handle = await startRuntime({ app, port: 0, dir: tmpDir })

    expect(handle.runtime).toBe('bun')
    expect(handle.pid).toBe(process.pid)
  })
})
