// Engine factory (ADR #8 — Session + Dispatch + opt-in Reactive tier).
//
// `createEngine` wires the function registry, the optional reactive tier, and
// per-Pipe session attachment into a single managed object.
//
// Usage:
//   const engine = createEngine(app, {
//     resolveContext, authTimeoutMs, subscriptions: app.subscriptions
//   })
//   const detach = engine.attach(pipe, {
//     upgradeRequest,
//     onSubAdded, onSubRemoved,       // caller tracks sub→pipe mapping
//     onMutation: (tables) => { ... } // caller fans out invalidation frames
//   })
//
// The caller (e.g. routes.ts) tracks which pipe holds which sub IDs via the
// onSubAdded / onSubRemoved callbacks, then routes invalidation frames itself.
// The engine deliberately does not own a global sub→pipe map so that the
// routes adapter controls the WS-tier invalidation dispatch (which requires
// the WSContext, not just a Pipe).

import type { Pipe } from '@wystack/transport'
import type { WyStackApp } from '../create'
import { createSession } from './session'
import { dispatch } from './dispatch'
import type { SubscriptionStore } from './types'

export type { SubscriptionStore } from './types'
export { dispatch } from './dispatch'

export interface EngineOptions {
  resolveContext?: (req: Request) => Promise<Record<string, unknown>>
  authTimeoutMs?: number
  /** Non-null enables the reactive tier (ADR #12). */
  subscriptions?: SubscriptionStore | null
}

export interface AttachOptions {
  /** The original HTTP upgrade Request (cookies, headers, URL). */
  upgradeRequest: Request
}

export interface Engine {
  /**
   * Attach the engine to a Pipe, wiring a Session to handle the full
   * auth + subscribe/unsubscribe lifecycle. Returns a `detach` function that
   * tears down the session and cleans up subscriptions.
   */
  attach(
    pipe: Pipe,
    attachOpts: AttachOptions & {
      onSubAdded?: (id: string) => void
      onSubRemoved?: (id: string) => void
      /** Called when a `call` mutation writes tables; caller handles invalidation. */
      onMutation?: (tablesWritten: Set<string>) => void
      /**
       * Called when the session self-closes (auth failure, timeout, send
       * error). Wire to the transport's own close event so teardown fires on
       * external disconnects too — `Pipe` has no built-in onClose hook.
       */
      onClose?: () => void
    },
  ): () => void

  /**
   * Dispatch an RPC call (path, args, context) directly — used by HTTP routes
   * and the Electron IPC call handler where there is no auth session to
   * re-enter. App is bound at engine creation time.
   */
  dispatch(
    path: string,
    args: unknown,
    context: Record<string, unknown>,
  ): ReturnType<typeof dispatch>
}

export function createEngine(app: WyStackApp, opts: EngineOptions = {}): Engine {
  const { resolveContext, authTimeoutMs = 10_000 } = opts
  const subscriptions = opts.subscriptions !== undefined ? opts.subscriptions : null

  return {
    attach(pipe, attachOpts) {
      const { upgradeRequest, onSubAdded, onSubRemoved, onMutation, onClose } = attachOpts
      return createSession(app, {
        pipe,
        upgradeRequest,
        resolveContext,
        authTimeoutMs,
        subscriptions,
        onSubAdded: onSubAdded ?? (() => {}),
        onSubRemoved: onSubRemoved ?? (() => {}),
        onMutation,
        onClose,
      })
    },

    dispatch: (path, args, context) => dispatch(app, path, args, context),
  }
}
