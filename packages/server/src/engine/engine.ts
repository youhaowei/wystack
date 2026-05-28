/**
 * Engine — wires Session + Dispatch to a `Pipe` for the RPC tier (auth + call).
 * Reactive tier (`subscribe` / invalidation) stays in `routes.ts` until T9;
 * subscribe on an engine-only attachment returns `REACTIVITY_NOT_ENABLED`.
 */
import { REACTIVITY_NOT_ENABLED, type ServerMessage } from '@wystack/transport'
import type { Pipe } from '@wystack/transport'
import type { WyStackApp } from '../create'
import { ValidationError } from '../validation'
import { createDispatch, type DispatchFn } from './dispatch'
import { createSession, normalizeInbound } from './session'

export interface EngineOptions {
  app: WyStackApp
  /**
   * Synthetic upgrade request for `resolveContext` — loopback tests use a
   * placeholder; WebSocket adapters pass the real HTTP upgrade Request.
   */
  upgradeRequest?: Request
  resolveContext?: (req: Request) => Promise<Record<string, unknown>>
  authTimeoutMs?: number
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toOutbound(payload: ServerMessage | Record<string, unknown>): unknown {
  return payload
}

/**
 * Attach the RPC engine to a per-connection `Pipe`. Returns a detach function
 * that unsubscribes the inbound handler and closes the session.
 */
export function attachEngine(pipe: Pipe, opts: EngineOptions): () => void {
  const userResolveContext = opts.resolveContext
  const requiresAuth = userResolveContext !== undefined
  const resolveContext = userResolveContext ?? (async () => ({}))
  const authTimeoutMs = opts.authTimeoutMs ?? 10_000
  const upgradeRequest =
    opts.upgradeRequest ?? new Request('http://loopback/ws', { method: 'GET' })
  const dispatch = createDispatch(opts.app)

  let session = createSession({
    requiresAuth,
    resolveContext,
    upgradeRequest,
    authTimeoutMs,
    onAuthenticated: () => {},
    onAuthFailed: () => {
      session.close()
      void pipe.close()
    },
    onTransientClose: () => {
      session.close()
      void pipe.close()
    },
    send: (payload) => {
      pipe.send(toOutbound(payload as ServerMessage))
    },
  })

  const unsubscribe = pipe.onMessage((raw) => {
    void handleInbound(raw)
  })

  async function handleInbound(raw: unknown): Promise<void> {
    const msg = normalizeInbound(raw)
    if (msg === null) {
      if (!session.authenticated) {
        session.close()
        void pipe.close()
        return
      }
      pipe.send(toOutbound({ type: 'error', error: 'invalid message' }))
      return
    }

    if (msg.type === 'auth') {
      await session.handleMessage(msg)
      return
    }

    if (!session.authenticated) {
      session.close()
      void pipe.close()
      return
    }

    if (msg.type === 'subscribe' || msg.type === 'unsubscribe') {
      const id = typeof msg.id === 'string' ? msg.id : undefined
      pipe.send(
        toOutbound({
          type: 'error',
          id,
          error: REACTIVITY_NOT_ENABLED,
        }),
      )
      return
    }

    if (msg.type === 'call') {
      await handleCall(msg)
      return
    }

    pipe.send(
      toOutbound({
        type: 'error',
        id: typeof msg.id === 'string' ? msg.id : undefined,
        error: `unknown message type: ${String(msg.type)}`,
      }),
    )
  }

  async function handleCall(msg: Record<string, unknown>): Promise<void> {
    if (typeof msg.id !== 'string' || typeof msg.path !== 'string') {
      pipe.send(toOutbound({ type: 'error', error: 'invalid call message' }))
      return
    }
    const id = msg.id
    const path = msg.path
    const args = msg.args ?? {}

    try {
      const { data } = await dispatch(path, args, session.context)
      pipe.send(toOutbound({ type: 'result', id, data }))
    } catch (err) {
      const payload: Record<string, unknown> = {
        type: 'error',
        id,
        error: errorMessage(err),
      }
      if (err instanceof ValidationError) payload.issues = err.issues
      pipe.send(toOutbound(payload))
    }
  }

  return () => {
    unsubscribe()
    session.close()
  }
}

export type { DispatchFn }
