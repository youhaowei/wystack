/**
 * Connection-timescale session — auth handshake, pre-auth gating, teardown.
 * Mirrors the shipped WebSocket behavior in `routes.ts` for Pipe transports.
 */

export function buildAuthRequest(upgradeRequest: Request, token: string | null): Request {
  const headers = new Headers(upgradeRequest.headers)
  if (token !== null && token.length > 0) {
    headers.set('authorization', `Bearer ${token}`)
  } else {
    headers.delete('authorization')
  }
  return new Request(upgradeRequest.url, {
    method: upgradeRequest.method,
    headers,
  })
}

export interface SessionOptions {
  requiresAuth: boolean
  resolveContext: (req: Request) => Promise<Record<string, unknown>>
  upgradeRequest: Request
  authTimeoutMs: number
  onAuthenticated: () => void
  onAuthFailed: () => void
  onTransientClose: () => void
  send: (payload: unknown) => void
}

export interface Session {
  readonly authenticated: boolean
  readonly token: string | null
  readonly context: Record<string, unknown>
  handleMessage(msg: Record<string, unknown>): Promise<'handled' | 'closed'>
  close(): void
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Loose envelope parse — matches `routes.ts` pre-dispatch policy.
 */
export function parseEnvelope(data: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const msg = parsed as Record<string, unknown>
  if (typeof msg.type !== 'string') return null
  return msg
}

export function normalizeInbound(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') return parseEnvelope(raw)
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const msg = raw as Record<string, unknown>
  if (typeof msg.type !== 'string') return null
  return msg
}

export function createSession(opts: SessionOptions): Session {
  const {
    requiresAuth,
    resolveContext,
    upgradeRequest,
    authTimeoutMs,
    onAuthenticated,
    onAuthFailed,
    onTransientClose,
    send,
  } = opts

  let authenticated = !requiresAuth
  let token: string | null = null
  let context: Record<string, unknown> = {}
  let closed = false

  const timeout =
    requiresAuth && authTimeoutMs > 0
      ? setTimeout(() => {
          if (!closed && !authenticated) onTransientClose()
        }, authTimeoutMs)
      : null

  async function resolveAuthContext(connToken: string | null): Promise<Record<string, unknown>> {
    const req = buildAuthRequest(upgradeRequest, connToken)
    return (await resolveContext(req)) ?? {}
  }

  async function handleAuthFrame(msg: Record<string, unknown>): Promise<void> {
    if (authenticated) {
      send({ type: 'authenticated' })
      return
    }

    const rawToken = msg.token
    const parsedToken = typeof rawToken === 'string' && rawToken.length > 0 ? rawToken : null

    try {
      const resolved = await resolveAuthContext(parsedToken)
      if (closed) return
      if (authenticated) {
        send({ type: 'authenticated' })
        return
      }
      token = parsedToken
      context = resolved
      if (timeout) clearTimeout(timeout)
      authenticated = true
      try {
        send({ type: 'authenticated' })
        onAuthenticated()
      } catch {
        onTransientClose()
      }
    } catch (err) {
      console.warn('[wystack/server] auth failed:', errorMessage(err))
      if (!closed && !authenticated) onAuthFailed()
    }
  }

  const session: Session = {
    get authenticated() {
      return authenticated
    },
    get token() {
      return token
    },
    get context() {
      return context
    },

    async handleMessage(msg) {
      if (closed) return 'closed'

      if (msg.type === 'auth') {
        await handleAuthFrame(msg)
        return closed ? 'closed' : 'handled'
      }

      if (!authenticated) {
        onAuthFailed()
        return 'closed'
      }

      return 'handled'
    },

    close() {
      if (closed) return
      closed = true
      if (timeout) clearTimeout(timeout)
    },
  }

  return session
}
