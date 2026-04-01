/**
 * Node entrypoint — Hono + @hono/node-server + @hono/node-ws
 */
import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { createApp } from './app'

const app = new Hono()
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })

const sharedApp = createApp(upgradeWebSocket)

// Mount shared routes onto the node app
app.route('/', sharedApp)

const port = Number(process.env.PORT) || 3101

const server = serve({ fetch: app.fetch, port }, () => {
  console.log(`[node] listening on http://localhost:${port}`)
})

injectWebSocket(server)
