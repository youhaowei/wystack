/**
 * Bun entrypoint — Hono + direct upgradeWebSocket/websocket from hono/bun
 */
import { upgradeWebSocket, websocket } from 'hono/bun'
import { createApp } from './app'

const app = createApp(upgradeWebSocket)

const port = Number(process.env.PORT) || 3100

Bun.serve({
  fetch: app.fetch,
  websocket,
  port,
})

console.log(`[bun] listening on http://localhost:${port}`)
