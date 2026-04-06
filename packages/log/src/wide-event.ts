import { logger } from './logger'
import type { WideEventFields } from './types'

export class WideEvent {
  private fields: Partial<WideEventFields> = {}
  private startTime: number
  private flushed = false

  constructor(eventName: string) {
    this.startTime = performance.now()
    this.fields.event_name = eventName
    this.fields.timestamp = new Date().toISOString()
  }

  set(fields: Partial<WideEventFields>) {
    Object.assign(this.fields, fields)
    return this
  }

  get<K extends keyof WideEventFields>(key: K) {
    return this.fields[key]
  }

  flush() {
    if (this.flushed) return
    this.flushed = true
    this.fields.duration_ms = Math.round(performance.now() - this.startTime)
    const { event_name, ...rest } = this.fields

    if (this.fields.outcome === 'error') {
      logger.error(rest, event_name)
    } else if (this.fields.duration_ms > 1000) {
      logger.warn(rest, event_name)
    } else {
      logger.info(rest, event_name)
    }
  }
}
