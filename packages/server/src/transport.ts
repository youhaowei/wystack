export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type TransportRequestType = 'query' | 'mutation' | 'subscribe'

export type TransportRequestMessage = {
  type: TransportRequestType
  id: string
  path: string
  args?: JsonValue
}

export type TransportUnsubscribeMessage = {
  type: 'unsubscribe'
  id: string
}

export type ClientTransportMessage = TransportRequestMessage | TransportUnsubscribeMessage

export type TransportResultMessage = {
  type: 'result'
  id: string
  data: JsonValue
}

export type TransportSubscribedMessage = {
  type: 'subscribed'
  id: string
}

export type TransportInvalidateMessage = {
  type: 'invalidate'
  id: string
  data?: JsonValue
}

export type TransportErrorMessage = {
  type: 'error'
  id?: string
  code: string
  message: string
  issues?: JsonValue
}

export type ServerTransportMessage =
  | TransportResultMessage
  | TransportSubscribedMessage
  | TransportInvalidateMessage
  | TransportErrorMessage

export type TransportMessage = ClientTransportMessage | ServerTransportMessage

export type TransportMessageHandler = (message: TransportMessage) => void

export type TransportEndpoint = {
  send(message: TransportMessage): void | Promise<void>
  onMessage(handler: TransportMessageHandler): () => void
  close(): void | Promise<void>
}

export type TransportProcedureContext = {
  subscriptionId?: string
}

export type TransportProcedureResult = {
  data: JsonValue
  tablesRead?: readonly string[]
  tablesWritten?: readonly string[]
}

export type TransportProcedure = (
  args: JsonValue | undefined,
  context: TransportProcedureContext,
) => Promise<TransportProcedureResult> | TransportProcedureResult

export type TransportRegistry = {
  queries?: Record<string, TransportProcedure>
  mutations?: Record<string, TransportProcedure>
}

export type TransportDispatcher = {
  dispose(): void
}

type Subscription = {
  id: string
  path: string
  args: JsonValue | undefined
  tablesRead: Set<string>
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return true
    case 'number':
      return Number.isFinite(value)
    case 'object':
      if (Array.isArray(value)) {
        return value.every(isJsonValue)
      }
      return Object.values(value as Record<string, unknown>).every(isJsonValue)
    default:
      return false
  }
}

export function parseClientMessage(value: unknown): ClientTransportMessage {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('Transport message must be an object with a type.')
  }

  if (value.type === 'unsubscribe') {
    if (typeof value.id !== 'string' || value.id.length === 0) {
      throw new Error('Transport unsubscribe message requires an id.')
    }
    return { type: 'unsubscribe', id: value.id }
  }

  if (value.type !== 'query' && value.type !== 'mutation' && value.type !== 'subscribe') {
    throw new Error(`Unsupported transport message type: ${value.type}`)
  }

  if (typeof value.id !== 'string' || value.id.length === 0) {
    throw new Error('Transport request message requires an id.')
  }
  if (typeof value.path !== 'string' || value.path.length === 0) {
    throw new Error('Transport request message requires a path.')
  }
  if ('args' in value && !isJsonValue(value.args)) {
    throw new Error('Transport request args must be JSON-serializable.')
  }

  return {
    type: value.type,
    id: value.id,
    path: value.path,
    args: value.args as JsonValue | undefined,
  }
}

export function createLoopbackPair(): {
  client: TransportEndpoint
  server: TransportEndpoint
} {
  const client = new LoopbackEndpoint()
  const server = new LoopbackEndpoint()
  client.peer = server
  server.peer = client
  return { client, server }
}

class LoopbackEndpoint implements TransportEndpoint {
  #handlers = new Set<TransportMessageHandler>()
  #closed = false
  peer?: LoopbackEndpoint

  send(message: TransportMessage): void {
    if (this.#closed || !this.peer || this.peer.#closed) return
    const peer = this.peer
    queueMicrotask(() => peer.deliver(message))
  }

  onMessage(handler: TransportMessageHandler): () => void {
    if (this.#closed) return () => {}
    this.#handlers.add(handler)
    return () => this.#handlers.delete(handler)
  }

  close(): void {
    this.#closed = true
    this.#handlers.clear()
  }

  private deliver(message: TransportMessage): void {
    if (this.#closed) return
    for (const handler of this.#handlers) {
      handler(message)
    }
  }
}

function errorMessage(
  message: string,
  options: { id?: string; code?: string; issues?: JsonValue } = {},
): TransportErrorMessage {
  return {
    type: 'error',
    id: options.id,
    code: options.code ?? 'BAD_REQUEST',
    message,
    issues: options.issues,
  }
}

function intersects(left: Set<string>, right: readonly string[]): boolean {
  return right.some((value) => left.has(value))
}

export function attachTransportDispatcher(
  endpoint: TransportEndpoint,
  registry: TransportRegistry,
): TransportDispatcher {
  const subscriptions = new Map<string, Subscription>()

  async function send(message: ServerTransportMessage): Promise<void> {
    await endpoint.send(message)
  }

  async function runQuery(
    id: string,
    path: string,
    args: JsonValue | undefined,
    subscriptionId?: string,
  ): Promise<TransportProcedureResult | null> {
    const procedure = registry.queries?.[path]
    if (!procedure) {
      await send(errorMessage(`Unknown query: ${path}`, { id, code: 'NOT_FOUND' }))
      return null
    }

    try {
      return await procedure(args, { subscriptionId })
    } catch (err) {
      await send(
        errorMessage(err instanceof Error ? err.message : String(err), {
          id,
          code: 'QUERY_FAILED',
        }),
      )
      return null
    }
  }

  async function runMutation(
    id: string,
    path: string,
    args: JsonValue | undefined,
  ): Promise<void> {
    const procedure = registry.mutations?.[path]
    if (!procedure) {
      await send(errorMessage(`Unknown mutation: ${path}`, { id, code: 'NOT_FOUND' }))
      return
    }

    let result: TransportProcedureResult
    try {
      result = await procedure(args, {})
    } catch (err) {
      await send(
        errorMessage(err instanceof Error ? err.message : String(err), {
          id,
          code: 'MUTATION_FAILED',
        }),
      )
      return
    }

    await send({ type: 'result', id, data: result.data })
    const tablesWritten = result.tablesWritten ?? []
    for (const subscription of subscriptions.values()) {
      if (intersects(subscription.tablesRead, tablesWritten)) {
        const queryResult = await runQuery(
          subscription.id,
          subscription.path,
          subscription.args,
          subscription.id,
        )
        if (queryResult) {
          subscription.tablesRead = new Set(queryResult.tablesRead ?? [])
          await send({
            type: 'invalidate',
            id: subscription.id,
            data: queryResult.data,
          })
        }
      }
    }
  }

  async function handleMessage(value: unknown): Promise<void> {
    let message
    try {
      message = parseClientMessage(value)
    } catch (err) {
      await send(
        errorMessage(err instanceof Error ? err.message : String(err), {
          code: 'INVALID_MESSAGE',
        }),
      )
      return
    }

    if (message.type === 'unsubscribe') {
      subscriptions.delete(message.id)
      return
    }

    if (message.type === 'query') {
      const result = await runQuery(message.id, message.path, message.args)
      if (result) {
        await send({ type: 'result', id: message.id, data: result.data })
      }
      return
    }

    if (message.type === 'mutation') {
      await runMutation(message.id, message.path, message.args)
      return
    }

    const result = await runQuery(message.id, message.path, message.args, message.id)
    if (!result) return
    subscriptions.set(message.id, {
      id: message.id,
      path: message.path,
      args: message.args,
      tablesRead: new Set(result.tablesRead ?? []),
    })
    await send({ type: 'subscribed', id: message.id })
  }

  const unsubscribe = endpoint.onMessage((message) => {
    void handleMessage(message)
  })

  return {
    dispose() {
      subscriptions.clear()
      unsubscribe()
    },
  }
}
