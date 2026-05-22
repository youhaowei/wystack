import { describe, expect, test } from 'bun:test'

import {
  attachTransportDispatcher,
  createLoopbackPair,
  isJsonValue,
  parseClientMessage,
  type TransportMessage,
} from '../transport'

async function waitForMessage(
  messages: TransportMessage[],
  predicate: (message: TransportMessage) => boolean = () => true,
): Promise<TransportMessage> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const index = messages.findIndex(predicate)
    if (index >= 0) {
      const [message] = messages.splice(index, 1)
      return message!
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('Timed out waiting for transport message')
}

describe('message transport', () => {
  test('delivers messages in both directions asynchronously', async () => {
    const { client, server } = createLoopbackPair()
    const serverMessages: TransportMessage[] = []
    const clientMessages: TransportMessage[] = []
    server.onMessage((message) => serverMessages.push(message))
    client.onMessage((message) => clientMessages.push(message))

    client.send({ type: 'query', id: 'q1', path: 'project.info' })
    server.send({ type: 'result', id: 'q1', data: { ok: true } })

    expect(await waitForMessage(serverMessages)).toEqual({
      type: 'query',
      id: 'q1',
      path: 'project.info',
    })
    expect(await waitForMessage(clientMessages)).toEqual({
      type: 'result',
      id: 'q1',
      data: { ok: true },
    })
  })

  test('stops delivering messages after unsubscribe and close', async () => {
    const { client, server } = createLoopbackPair()
    let count = 0
    const unsubscribe = server.onMessage(() => count++)

    unsubscribe()
    client.send({ type: 'query', id: 'q1', path: 'project.info' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(count).toBe(0)

    server.onMessage(() => count++)
    server.close()
    client.send({ type: 'query', id: 'q2', path: 'project.info' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(count).toBe(0)
  })

  test('validates JSON values and parses request messages', () => {
    expect(isJsonValue(['value', false, 2])).toBe(true)
    expect(isJsonValue({ name: 'DashFrame', ok: true })).toBe(true)
    expect(
      parseClientMessage({
        type: 'mutation',
        id: 'm1',
        path: 'project.rename',
        args: { name: 'After' },
      }),
    ).toEqual({
      type: 'mutation',
      id: 'm1',
      path: 'project.rename',
      args: { name: 'After' },
    })
  })
})

describe('attachTransportDispatcher', () => {
  test('returns query results', async () => {
    const { client, server } = createLoopbackPair()
    const messages: TransportMessage[] = []
    client.onMessage((message) => messages.push(message))
    attachTransportDispatcher(server, {
      queries: {
        'project.info': () => ({
          data: { name: 'DashFrame' },
          tablesRead: ['project'],
        }),
      },
    })

    client.send({ type: 'query', id: 'q1', path: 'project.info' })

    expect(await waitForMessage(messages)).toEqual({
      type: 'result',
      id: 'q1',
      data: { name: 'DashFrame' },
    })
  })

  test('invalidates subscriptions after related mutations', async () => {
    const { client, server } = createLoopbackPair()
    const messages: TransportMessage[] = []
    let name = 'Before'
    client.onMessage((message) => messages.push(message))
    attachTransportDispatcher(server, {
      queries: {
        'project.info': () => ({
          data: { name },
          tablesRead: ['project'],
        }),
      },
      mutations: {
        'project.rename': (args) => {
          name =
            typeof args === 'object' &&
            args !== null &&
            !Array.isArray(args) &&
            typeof args.name === 'string'
              ? args.name
              : name
          return {
            data: { ok: true },
            tablesWritten: ['project'],
          }
        },
      },
    })

    client.send({ type: 'subscribe', id: 's1', path: 'project.info' })
    expect(await waitForMessage(messages)).toEqual({
      type: 'subscribed',
      id: 's1',
    })

    client.send({
      type: 'mutation',
      id: 'm1',
      path: 'project.rename',
      args: { name: 'After' },
    })

    expect(await waitForMessage(messages, (message) => message.type === 'result')).toEqual({
      type: 'result',
      id: 'm1',
      data: { ok: true },
    })
    expect(await waitForMessage(messages, (message) => message.type === 'invalidate')).toEqual({
      type: 'invalidate',
      id: 's1',
      data: { name: 'After' },
    })
  })

  test('returns errors for unknown procedures', async () => {
    const { client, server } = createLoopbackPair()
    const messages: TransportMessage[] = []
    client.onMessage((message) => messages.push(message))
    attachTransportDispatcher(server, {})

    client.send({ type: 'query', id: 'q1', path: 'missing' })

    expect(await waitForMessage(messages)).toMatchObject({
      type: 'error',
      id: 'q1',
      code: 'NOT_FOUND',
    })
  })
})
