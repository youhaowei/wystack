import { describe, expect, test } from 'bun:test'
import { WS_CLOSE_AUTH_FAILED, WS_CLOSE_TRANSIENT } from './index'

describe('@wystack/protocol', () => {
  test('exports stable WebSocket close codes', () => {
    expect(WS_CLOSE_AUTH_FAILED).toBe(4001)
    expect(WS_CLOSE_TRANSIENT).toBe(4002)
  })
})
