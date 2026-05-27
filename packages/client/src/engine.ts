import type { ClientMessage, Pipe, ServerMessage } from '@wystack/transport'

type InvalidateHandler = () => void

export interface ClientEnginePipe {
  pipe: Pipe<ServerMessage, ClientMessage>
  closed: Promise<ClientEngineCloseEvent>
}

export interface ClientEngineCloseEvent {
  code?: number
  reason?: string
}

export interface ClientEngineConfig {
  createPipe: () => Promise<ClientEnginePipe> | ClientEnginePipe
  getToken?: () => Promise<string | null> | string | null
  requiresAuth?: boolean
  authAckTimeoutMs?: number
  reconnectDelayMs?: (attempt: number) => number
  onSubscribed?: (id: string) => void
  onProtocolError?: (error: unknown) => void
}

export interface ClientEngine {
  connect(): void
  disconnect(): void
  subscribe(
    id: string,
    path: string,
    args: Record<string, unknown>,
    onInvalidate: InvalidateHandler,
  ): void
  unsubscribe(id: string): void
  isConnected(): boolean
  isAuthenticated(): boolean
}

export function createClientEngine(config: ClientEngineConfig): ClientEngine {
  const requiresAuth = config.requiresAuth ?? config.getToken !== undefined
  const authAckTimeoutMs = config.authAckTimeoutMs ?? 10_000
  const reconnectDelayMs = config.reconnectDelayMs ?? defaultReconnectDelayMs

  let pipe: Pipe<ServerMessage, ClientMessage> | null = null
  let unsubscribeMessages: (() => void) | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let authAckTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectAttempt = 0
  let connected = false
  let authenticated = false
  let authFailed = false
  let connectGeneration = 0
  let connectPending = false

  const handlers = new Map<string, InvalidateHandler>()
  const activeSubs = new Map<string, { path: string; args: Record<string, unknown> }>()

  function clearAuthAckTimer() {
    if (authAckTimer) {
      clearTimeout(authAckTimer)
      authAckTimer = null
    }
  }

  function clearReconnectTimer() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  }

  function scheduleReconnect() {
    if (authFailed || reconnectTimer) return
    const delay = reconnectDelayMs(reconnectAttempt)
    reconnectAttempt++
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function sendSubscriptions() {
    if (!pipe || !authenticated) return
    for (const [id, sub] of activeSubs) {
      void pipe.send({ type: 'subscribe', id, path: sub.path, args: sub.args })
    }
  }

  function handleMessage(message: ServerMessage) {
    reconnectAttempt = 0
    if (message.type === 'authenticated') {
      if (authenticated) return
      authenticated = true
      clearAuthAckTimer()
      sendSubscriptions()
      return
    }
    if (message.type === 'invalidate') {
      handlers.get(message.id)?.()
      return
    }
    if (message.type === 'subscribed') {
      config.onSubscribed?.(message.id)
    }
  }

  function handleClose(event: ClientEngineCloseEvent) {
    connected = false
    authenticated = false
    pipe = null
    unsubscribeMessages?.()
    unsubscribeMessages = null
    clearAuthAckTimer()

    if (event.code === 4001 || authFailed) {
      authFailed = true
      for (const handler of handlers.values()) handler()
      return
    }
    scheduleReconnect()
  }

  function connect() {
    if (authFailed || pipe || reconnectTimer || connectPending) return
    const generation = ++connectGeneration
    connectPending = true

    const tokenPromise = requiresAuth
      ? Promise.resolve().then(() => config.getToken?.())
      : Promise.resolve(null)

    tokenPromise
      .then((token) => Promise.resolve(config.createPipe()).then((next) => ({ token, next })))
      .then(({ token, next }) => {
        if (generation !== connectGeneration || authFailed || pipe) {
          void next.pipe.close()
          return
        }

        connectPending = false
        pipe = next.pipe
        connected = true
        authenticated = !requiresAuth
        unsubscribeMessages = next.pipe.onMessage(handleMessage)

        next.closed.then((event) => {
          if (generation !== connectGeneration) return
          handleClose(event)
        })

        if (requiresAuth) {
          void next.pipe.send({ type: 'auth', token: token ?? null })
          authAckTimer = setTimeout(() => {
            authAckTimer = null
            void next.pipe.close()
          }, authAckTimeoutMs)
        } else {
          sendSubscriptions()
        }
      })
      .catch((error) => {
        if (generation !== connectGeneration) return
        connectPending = false
        config.onProtocolError?.(error)
        scheduleReconnect()
      })
  }

  function disconnect() {
    connectGeneration++
    connectPending = false
    clearReconnectTimer()
    clearAuthAckTimer()
    authFailed = false
    connected = false
    authenticated = false
    unsubscribeMessages?.()
    unsubscribeMessages = null
    const current = pipe
    pipe = null
    if (current) void current.close()
  }

  function subscribe(
    id: string,
    path: string,
    args: Record<string, unknown>,
    onInvalidate: InvalidateHandler,
  ) {
    handlers.set(id, onInvalidate)
    activeSubs.set(id, { path, args })
    if (pipe && authenticated) {
      void pipe.send({ type: 'subscribe', id, path, args })
    }
  }

  function unsubscribe(id: string) {
    handlers.delete(id)
    activeSubs.delete(id)
    if (pipe && authenticated) {
      void pipe.send({ type: 'unsubscribe', id })
    }
  }

  return {
    connect,
    disconnect,
    subscribe,
    unsubscribe,
    isConnected: () => connected,
    isAuthenticated: () => authenticated,
  }
}

function defaultReconnectDelayMs(attempt: number): number {
  const base = 1000 * 2 ** Math.min(attempt, 5)
  const jitter = base * (0.5 + Math.random() * 0.5)
  return Math.min(jitter, 30000)
}
