import pino from 'pino'
import type { TraceyConfig } from './types'
import { initRingBuffer } from './ring-buffer'
import { Writable } from 'node:stream'

function createDefaultLogger() {
  const isDev = process.env.NODE_ENV !== 'production'
  const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')

  return pino({
    level,
    ...(isDev && {
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'HH:MM:ss.l',
        },
      },
    }),
  })
}

// Singleton — survives HMR via globalThis
const g = globalThis as Record<string, unknown>

function current(): pino.Logger {
  return (g.__wystack_logger__ ??= createDefaultLogger()) as pino.Logger
}

/** Root logger singleton. Always delegates to the current pino instance. */
export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop, receiver) {
    const inst = current()
    const val = Reflect.get(inst, prop, receiver)
    return typeof val === 'function' ? val.bind(inst) : val
  },
})

/** Create a named child logger. All entries include `component: name`. */
export function createLogger(name: string): pino.Logger {
  return current().child({ component: name })
}

/** Initialize logging with full config (ring buffer, file transport, redaction). */
export function initTracey(config: TraceyConfig) {
  const isDev = process.env.NODE_ENV !== 'production'
  const isPretty = process.env.LOG_PRETTY === '1' || (isDev && process.stdout.isTTY)
  const level = config.level ?? process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')

  const streams: pino.StreamEntry[] = []

  // Pretty or JSON stdout
  if (isPretty) {
    streams.push({
      level: level as pino.Level,
      stream: pino.transport({
        target: 'pino-pretty',
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'HH:MM:ss.l',
        },
      }),
    })
  } else {
    streams.push({ level: level as pino.Level, stream: process.stdout })
  }

  // Ring buffer
  const ringSize = config.ringBuffer ?? 1000
  if (ringSize !== false) {
    const ring = initRingBuffer(ringSize)
    const ringStream = new Writable({
      write(chunk, _encoding, callback) {
        try {
          const entry = JSON.parse(chunk.toString())
          ring.push(entry)
        } catch {
          // ignore parse errors
        }
        callback()
      },
    })
    streams.push({ level: level as pino.Level, stream: ringStream })
  }

  const opts: pino.LoggerOptions = {
    level,
    ...(config.redact !== false && {
      redact: {
        paths: ['*.password', '*.secret', '*.token', '*.api_key', '*.apikey', '*.authorization'],
        censor: '[REDACTED]',
      },
    }),
  }

  g.__wystack_logger__ = pino(opts, pino.multistream(streams))
}
