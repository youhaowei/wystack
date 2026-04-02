/**
 * Deprecated — use runtime-specific entrypoints:
 *   import { serve } from '@wystack/server/bun'
 *   import { serve } from '@wystack/server/node'
 *
 * Or for embedded mode (mount into an existing Hono app):
 *   import { createRoutes } from '@wystack/server'
 *
 * This file re-exports the Bun entrypoint for backwards compatibility
 * and will be removed in a future major version.
 */
export { serve } from './serve-bun'
export type { WyStackServer } from './serve-bun'
