/**
 * Test client — validates the full WyStack WS protocol against a server.
 *
 * Usage:
 *   bun client.ts [port]      # default 3100
 *   node --experimental-websocket client.ts [port]   # Node 22+
 *
 * Tests:
 *   1. Subscribe → receives 'subscribed' ack
 *   2. HTTP POST mutation → receives 'invalidate' signal
 *   3. Unsubscribe → receives 'unsubscribed' ack
 *   4. After unsubscribe, mutation does NOT trigger invalidation
 *   5. Reconnect leak test — connect/disconnect 10 times
 */

const port = process.argv[2] ?? '3100'
const BASE = `http://localhost:${port}`
const WS_URL = `ws://localhost:${port}/wystack/ws`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    ws.onopen = () => resolve(ws)
    ws.onerror = (e) => reject(e)
  })
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`)),
      timeoutMs,
    )
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(String(event.data)) as Record<string, unknown>
      if (predicate(data)) {
        clearTimeout(timer)
        ws.removeEventListener('message', handler)
        resolve(data)
      }
    }
    ws.addEventListener('message', handler)
  })
}

async function postMutation(fn: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${BASE}/wystack/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

function closeAndWait(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) {
      resolve()
      return
    }
    ws.onclose = () => resolve()
    ws.close()
  })
}

let passed = 0
let failed = 0

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`)
    passed++
  } else {
    console.error(`  FAIL  ${label}`)
    failed++
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testSubscribeAndInvalidate(): Promise<void> {
  console.log('\n--- Test: subscribe → mutate → invalidate ---')
  const ws = await connect()

  // Subscribe
  ws.send(JSON.stringify({ type: 'subscribe', id: 'sub-1', path: 'getCounter', args: {} }))
  const ack = await waitForMessage(ws, (m) => m.type === 'subscribed' && m.id === 'sub-1')
  assert(ack.type === 'subscribed', 'receives subscribed ack')

  // Install listener BEFORE mutation (server sends invalidation before HTTP response)
  const invPromise = waitForMessage(ws, (m) => m.type === 'invalidate' && m.id === 'sub-1')

  // Mutate via HTTP
  const mutRes = await postMutation('increment')
  assert(
    typeof mutRes === 'object' && mutRes !== null && 'data' in mutRes,
    'mutation returns data',
  )

  // Wait for invalidation
  const inv = await invPromise
  assert(inv.type === 'invalidate', 'receives invalidation signal')

  await closeAndWait(ws)
}

async function testUnsubscribe(): Promise<void> {
  console.log('\n--- Test: unsubscribe stops invalidation ---')
  const ws = await connect()

  // Subscribe
  ws.send(JSON.stringify({ type: 'subscribe', id: 'sub-2', path: 'getCounter', args: {} }))
  await waitForMessage(ws, (m) => m.type === 'subscribed' && m.id === 'sub-2')

  // Unsubscribe
  ws.send(JSON.stringify({ type: 'unsubscribe', id: 'sub-2' }))
  const unsub = await waitForMessage(ws, (m) => m.type === 'unsubscribed' && m.id === 'sub-2')
  assert(unsub.type === 'unsubscribed', 'receives unsubscribed ack')

  // Mutate — should NOT get invalidation (listen before POST to avoid races)
  const noInvPromise = waitForMessage(ws, (m) => m.type === 'invalidate', 500)
  await postMutation('increment')

  let gotInvalidation = false
  try {
    await noInvPromise
    gotInvalidation = true
  } catch {
    // Expected: timeout = no invalidation sent
  }
  assert(!gotInvalidation, 'no invalidation after unsubscribe')

  await closeAndWait(ws)
}

async function testReconnectLeak(): Promise<void> {
  console.log('\n--- Test: reconnect leak (10 cycles) ---')
  const rounds = 10

  for (let i = 0; i < rounds; i++) {
    const ws = await connect()
    ws.send(
      JSON.stringify({ type: 'subscribe', id: `leak-${i}`, path: 'getCounter', args: {} }),
    )
    await waitForMessage(ws, (m) => m.type === 'subscribed')
    await closeAndWait(ws)
  }

  // Give server time to process all close events
  await new Promise((r) => setTimeout(r, 200))

  // Check server diagnostics for leaks
  const diag = (await (await fetch(BASE)).json()) as Record<string, unknown>
  console.log('  Server state after disconnects:', JSON.stringify(diag))
  assert(diag.subscriptions === 0, `no leaked subscriptions (got ${diag.subscriptions})`)
  assert(diag.trackedSockets === 0, `no leaked socket refs (got ${diag.trackedSockets})`)

  // After all disconnected, a mutation should not cause errors
  const res = await postMutation('increment')
  assert(
    typeof res === 'object' && res !== null && 'data' in res,
    `mutation succeeds after ${rounds} connect/disconnect cycles`,
  )

  // Connect once more and verify subscribe still works
  const ws = await connect()
  ws.send(JSON.stringify({ type: 'subscribe', id: 'post-leak', path: 'getCounter', args: {} }))
  const ack = await waitForMessage(ws, (m) => m.type === 'subscribed')
  assert(ack.id === 'post-leak', 'fresh subscribe works after reconnect cycles')

  await closeAndWait(ws)
}

async function testErrorOnUnknownQuery(): Promise<void> {
  console.log('\n--- Test: error on unknown query ---')
  const ws = await connect()

  ws.send(JSON.stringify({ type: 'subscribe', id: 'bad-1', path: 'nonexistent', args: {} }))
  const err = await waitForMessage(ws, (m) => m.type === 'error' && m.id === 'bad-1')
  assert(typeof err.error === 'string', 'receives error for unknown query')

  await closeAndWait(ws)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`Testing against ${BASE}`)

  try {
    await testSubscribeAndInvalidate()
    await testUnsubscribe()
    await testReconnectLeak()
    await testErrorOnUnknownQuery()
  } catch (err) {
    console.error('\nFATAL:', err)
    failed++
  }

  console.log(`\n=============================`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  console.log(`=============================`)

  process.exit(failed > 0 ? 1 : 0)
}

main()
