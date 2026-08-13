/**
 * WyStack Client — manages HTTP calls (GET queries, POST mutations)
 * and WS connection for live invalidation.
 *
 * The app provides getToken for HTTP auth. WebSocket auth is optional and can
 * be disabled for trusted transports via `requiresAuth: false`.
 */
import type { WyStackClientConfig } from './types'
import type { QueryRef, MutationRef, ActionRef, RefArgs, RefReturn } from './refs'
import { createWsManager, type WsManager } from './ws'
import type { Client } from './core-client'

export interface WyStackClient {
  url: string
  prefix: string
  ws: WsManager
  /** Fetch a query result via GET */
  query<TRef extends QueryRef>(ref: TRef, args?: RefArgs<TRef>): Promise<RefReturn<TRef>>
  /** Execute a mutation via POST */
  mutate<TRef extends MutationRef>(ref: TRef, args?: RefArgs<TRef>): Promise<RefReturn<TRef>>
  /** Execute a non-reactive action via POST. Aborting stops the HTTP request; server cancellation is not guaranteed. */
  action<TRef extends ActionRef>(
    ref: TRef,
    args?: RefArgs<TRef>,
    options?: { signal?: AbortSignal },
  ): Promise<RefReturn<TRef>>
}

/** Web client with the transport-neutral lifecycle used by React bindings. */
export interface WebClient extends WyStackClient, Client {}

function defaultCreateSubscriptionId(): string {
  return `wy_${globalThis.crypto.randomUUID()}`
}

export function isWebClient(client: Client | WyStackClient): client is WebClient {
  const candidate = client as Partial<Client & WyStackClient>
  return (
    typeof candidate.url === 'string' &&
    typeof candidate.prefix === 'string' &&
    typeof candidate.ws === 'object' &&
    candidate.ws !== null &&
    typeof candidate.connect === 'function' &&
    typeof candidate.disconnect === 'function' &&
    typeof candidate.subscribe === 'function'
  )
}

/** Adapt the legacy web client shape to the shared client contract. */
export function toWebClient(
  client: WyStackClient,
  createSubscriptionId: () => string = defaultCreateSubscriptionId,
): WebClient {
  if (isWebClient(client)) return client

  return {
    url: client.url,
    prefix: client.prefix,
    ws: client.ws,
    query: (ref, args) => client.query(ref, args),
    mutate: (ref, args) => client.mutate(ref, args),
    action: (ref, args, options) => client.action(ref, args, options),
    connect: () => client.ws.connect(),
    disconnect: () => client.ws.disconnect(),
    subscribe(path, args, onInvalidate, onError) {
      const id = createSubscriptionId()
      client.ws.subscribe(id, path, args, onInvalidate, onError)
      let active = true
      return () => {
        if (!active) return
        active = false
        client.ws.unsubscribe(id)
      }
    },
  }
}

/**
 * Build the Error to throw for a non-2xx response, preserving the server's
 * message so callers can pattern-match on it (e.g. drift/validation copy).
 *
 * Body shape is `{ error: string, ... }` per @wystack/server's routes.ts, but
 * this also tolerates a non-JSON text body (raw text becomes the message) and
 * an empty body (falls back to `HTTP ${status}`). The HTTP status is attached
 * as a `status` property on the Error for callers that want to introspect it,
 * without inventing a bespoke error class.
 */
async function readHttpError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => '')
  if (!text) {
    return Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // Non-JSON body — surface the raw text as the message.
    return Object.assign(new Error(text), { status: res.status })
  }
  const message =
    parsed &&
    typeof parsed === 'object' &&
    typeof (parsed as { error?: unknown }).error === 'string'
      ? (parsed as { error: string }).error
      : text
  return Object.assign(new Error(message), { status: res.status })
}

export function createClient(config: WyStackClientConfig): WebClient {
  const httpUrl = config.url.replace(/\/$/, '')
  const prefix = config.prefix ?? '/api'
  const getToken = config.getToken

  const wsUrl = httpUrl.replace(/^http/, 'ws') + `${prefix}/ws`
  const ws = createWsManager({ url: wsUrl, getToken, requiresAuth: config.requiresAuth })

  async function getAuthHeaders(): Promise<Record<string, string>> {
    const token = await getToken?.()
    return token ? { Authorization: `Bearer ${token}` } : {}
  }

  const client: WyStackClient = {
    url: httpUrl,
    prefix,
    ws,

    async query(ref: QueryRef, args?: unknown) {
      const path = ref._path
      const auth = await getAuthHeaders()
      // TODO: fall back to POST for large args that would exceed URL length limits
      const argsParam =
        args !== undefined ? `?args=${encodeURIComponent(JSON.stringify(args))}` : ''
      const res = await fetch(`${httpUrl}${prefix}/${path}${argsParam}`, {
        headers: auth,
      })
      if (!res.ok) {
        throw await readHttpError(res)
      }
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      return json.data
    },

    async mutate(ref: MutationRef, args?: unknown) {
      const path = ref._path
      const auth = await getAuthHeaders()
      const res = await fetch(`${httpUrl}${prefix}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...auth },
        body: JSON.stringify(args ?? {}),
      })
      if (!res.ok) {
        throw await readHttpError(res)
      }
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      return json.data
    },

    async action(ref: ActionRef, args?: unknown, options?: { signal?: AbortSignal }) {
      const path = ref._path
      const auth = await getAuthHeaders()
      const res = await fetch(`${httpUrl}${prefix}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WyStack-Function-Kind': 'action',
          ...auth,
        },
        body: JSON.stringify(args ?? {}),
        signal: options?.signal,
      })
      if (!res.ok) throw await readHttpError(res)
      const json = await res.json()
      if (json.error) throw new Error(json.error)
      return json.data
    },
  }

  return toWebClient(client, config.createSubscriptionId)
}
