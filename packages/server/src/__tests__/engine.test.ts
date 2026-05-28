import { describe, test, expect, beforeEach } from 'bun:test'
import { createDb, defineSchema, text, int, boolean } from '@wystack/db'
import { createLoopbackPair, REACTIVITY_NOT_ENABLED } from '@wystack/transport'
import type { ClientMessage, ServerMessage } from '@wystack/transport'
import { createWyStack } from '../create'
import { query, mutation } from '../functions'
import { attachEngine, buildAuthRequest, createDispatch } from '../engine'

const schema = defineSchema({
  todos: {
    id: int.primaryKey(),
    title: text,
    done: boolean,
  },
})

function collectMessages<T>(pipe: { onMessage: (h: (m: T) => void) => () => void }) {
  const messages: T[] = []
  const unsub = pipe.onMessage((m) => messages.push(m))
  return { messages, unsub }
}

function nextMessage<T>(messages: T[], predicate: (m: T) => boolean, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('timeout waiting for message')), ms)
    const interval = setInterval(() => {
      const hit = messages.find(predicate)
      if (hit) {
        clearTimeout(deadline)
        clearInterval(interval)
        resolve(hit)
      }
    }, 10)
  })
}

describe('createDispatch', () => {
  test('returns data and table metadata from app.call', async () => {
    const db = await createDb({ dev: 'pglite://' })
    await db.execute(
      `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
    )
    const app = await createWyStack({
      db,
      functions: {
        listTodos: query({
          args: {},
          handler: async (ctx) => ctx.db.from(schema.todos).all(),
        }),
      },
    })
    const dispatch = createDispatch(app)
    const { data, tablesRead } = await dispatch('listTodos', {}, {})
    expect(data).toEqual([])
    expect(tablesRead).toBeInstanceOf(Set)
  })
})

describe('buildAuthRequest (engine export)', () => {
  test('null token strips Authorization from upgrade', () => {
    const upgrade = new Request('http://x/ws', {
      headers: { authorization: 'Bearer leaked' },
    })
    const req = buildAuthRequest(upgrade, null)
    expect(req.headers.get('authorization')).toBeNull()
  })
})

describe('attachEngine over loopback', () => {
  let app: Awaited<ReturnType<typeof createWyStack>>

  beforeEach(async () => {
    const db = await createDb({ dev: 'pglite://' })
    await db.execute(
      `CREATE TABLE IF NOT EXISTS todos (id SERIAL PRIMARY KEY, title TEXT NOT NULL, done BOOLEAN NOT NULL)`,
    )
    app = await createWyStack({
      db,
      functions: {
        listTodos: query({
          args: {},
          handler: async (ctx) => ctx.db.from(schema.todos).all(),
        }),
        whoami: query({
          args: {},
          handler: async (ctx) => ({ userId: ctx.userId as string | undefined }),
        }),
        addTodo: mutation({
          args: { title: text },
          handler: async (ctx, args) =>
            ctx.db.into(schema.todos).insert({ title: args.title, done: false }),
        }),
      },
    })
  })

  test('RPC call on no-auth pipe returns result', async () => {
    const [server, client] = createLoopbackPair<ClientMessage, ServerMessage>()
    const { messages, unsub } = collectMessages(client)
    attachEngine(server, { app })

    client.send({ type: 'call', id: 'c1', path: 'listTodos', args: {} })

    const msg = await nextMessage(messages, (m) => m.type === 'result')
    expect(msg).toEqual({ type: 'result', id: 'c1', data: [] })
    unsub()
    client.close()
  })

  test('subscribe returns REACTIVITY_NOT_ENABLED', async () => {
    const [server, client] = createLoopbackPair<ClientMessage, ServerMessage>()
    const { messages, unsub } = collectMessages(client)
    attachEngine(server, { app })

    client.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })

    const msg = await nextMessage(messages, (m) => m.type === 'error')
    expect(msg).toEqual({
      type: 'error',
      id: 's1',
      error: REACTIVITY_NOT_ENABLED,
    })
    unsub()
    client.close()
  })

  test('auth handshake then call uses resolved context', async () => {
    const [server, client] = createLoopbackPair<ClientMessage, ServerMessage>()
    const { messages, unsub } = collectMessages(client)
    attachEngine(server, {
      app,
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    client.send({ type: 'auth', token: 'user_42' })
    await nextMessage(messages, (m) => m.type === 'authenticated')

    client.send({ type: 'call', id: 'c2', path: 'whoami', args: {} })
    const result = await nextMessage(messages, (m) => m.type === 'result')
    expect(result).toEqual({ type: 'result', id: 'c2', data: { userId: 'user_42' } })
    unsub()
    client.close()
  })

  test('subscribe before auth closes the pipe', async () => {
    const [server, client] = createLoopbackPair<ClientMessage, ServerMessage>()
    let serverClosed = false
    const origClose = server.close.bind(server)
    server.close = () => {
      serverClosed = true
      return origClose()
    }

    attachEngine(server, {
      app,
      authTimeoutMs: 5000,
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '')
        if (!token) throw new Error('Unauthorized')
        return { userId: token }
      },
    })

    client.send({ type: 'subscribe', id: 's1', path: 'listTodos', args: {} })
    await new Promise((r) => setTimeout(r, 50))
    expect(serverClosed).toBe(true)
    client.close()
  })

  test('invalid auth token closes the pipe', async () => {
    const [server, client] = createLoopbackPair<ClientMessage, ServerMessage>()
    let serverClosed = false
    const origClose = server.close.bind(server)
    server.close = () => {
      serverClosed = true
      return origClose()
    }

    attachEngine(server, {
      app,
      resolveContext: async () => {
        throw new Error('bad token')
      },
    })

    client.send({ type: 'auth', token: 'bad' })
    await new Promise((r) => setTimeout(r, 50))
    expect(serverClosed).toBe(true)
    client.close()
  })

  test('anonymous auth succeeds when resolveContext accepts null token', async () => {
    const [server, client] = createLoopbackPair<ClientMessage, ServerMessage>()
    const { messages, unsub } = collectMessages(client)
    attachEngine(server, {
      app,
      resolveContext: async (req) => {
        const token = req.headers.get('authorization')?.replace('Bearer ', '') ?? null
        return { userId: token ?? 'anon' }
      },
    })

    client.send({ type: 'auth', token: null })
    const ack = await nextMessage(messages, (m) => m.type === 'authenticated')
    expect(ack).toEqual({ type: 'authenticated' })
    unsub()
    client.close()
  })

  test('idempotent auth ACK on no-auth pipe does not adopt token into call context', async () => {
    const [server, client] = createLoopbackPair<ClientMessage, ServerMessage>()
    const { messages, unsub } = collectMessages(client)
    attachEngine(server, { app })

    client.send({ type: 'auth', token: 'must_not_be_trusted' })
    await nextMessage(messages, (m) => m.type === 'authenticated')

    client.send({ type: 'call', id: 'c3', path: 'whoami', args: {} })
    const result = await nextMessage(messages, (m) => m.type === 'result')
    expect(result).toEqual({ type: 'result', id: 'c3', data: { userId: undefined } })
    unsub()
    client.close()
  })

  test('malformed first frame closes pipe when auth is required', async () => {
    const [server, client] = createLoopbackPair<ClientMessage, ServerMessage>()
    let serverClosed = false
    const origClose = server.close.bind(server)
    server.close = () => {
      serverClosed = true
      return origClose()
    }

    attachEngine(server, {
      app,
      resolveContext: async () => ({}),
    })

    client.send('not json' as unknown as ClientMessage)
    await new Promise((r) => setTimeout(r, 50))
    expect(serverClosed).toBe(true)
    client.close()
  })
})
