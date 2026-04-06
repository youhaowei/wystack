import { logger } from './logger'
import { WideEvent } from './wide-event'

export function logDbInit(phase: string, durationMs: number) {
  logger.debug({ phase, duration_ms: Math.round(durationMs) }, 'db.init')
}

export function createDbEvent() {
  return new WideEvent('db.lifecycle')
}
