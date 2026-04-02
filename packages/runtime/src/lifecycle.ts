/**
 * Lifecycle manager — ordered startup/shutdown hooks with error resilience.
 *
 * Start hooks run in registration order (first registered = first to run).
 * Stop hooks run in reverse order (last registered = first to run),
 * matching the common "tear down in reverse order of setup" pattern.
 *
 * Both start() and stop() are idempotent — calling them multiple times
 * is safe and only executes hooks once.
 */

export type LifecycleState = 'idle' | 'running' | 'stopped'

type Hook = () => void | Promise<void>

export interface Lifecycle {
  /** Register a hook to run on startup. Hooks run in registration order. */
  onStart(hook: Hook): void
  /** Register a hook to run on shutdown. Hooks run in reverse registration order. */
  onStop(hook: Hook): void
  /** Run all start hooks. Idempotent — only runs once. */
  start(): Promise<void>
  /** Run all stop hooks. Idempotent — only runs once. Returns any errors from hooks. */
  stop(): Promise<Error[]>
  /** Current lifecycle state. */
  readonly state: LifecycleState
}

export function createLifecycle(): Lifecycle {
  const startHooks: Hook[] = []
  const stopHooks: Hook[] = []
  let state: LifecycleState = 'idle'

  return {
    get state() {
      return state
    },

    onStart(hook: Hook) {
      startHooks.push(hook)
    },

    onStop(hook: Hook) {
      stopHooks.push(hook)
    },

    async start() {
      if (state !== 'idle') return
      for (const hook of startHooks) {
        await hook()
      }
      state = 'running'
    },

    async stop() {
      if (state === 'stopped') return []
      const errors: Error[] = []
      // Run in reverse order — last registered runs first
      for (let i = stopHooks.length - 1; i >= 0; i--) {
        try {
          await stopHooks[i]()
        } catch (err) {
          errors.push(err instanceof Error ? err : new Error(String(err)))
        }
      }
      state = 'stopped'
      return errors
    },
  }
}
