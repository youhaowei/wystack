import pino from 'pino'
import type { TraceyConfig } from './types'
import { DEFAULT_RING_SIZE, initRingBuffer, clearRingBuffer } from './ring-buffer'
import { Writable } from 'node:stream'

const isDev = process.env.NODE_ENV !== 'production'

const PINO_PRETTY_OPTIONS = {
  colorize: true,
  ignore: 'pid,hostname',
  translateTime: 'HH:mm:ss.l',
} as const

function createDefaultLogger() {
  const level = process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')

  let hasPinoPretty = false
  if (isDev) {
    try {
      require.resolve('pino-pretty')
      hasPinoPretty = true
    } catch {}
  }

  return pino({
    level,
    ...(hasPinoPretty && {
      transport: { target: 'pino-pretty', options: PINO_PRETTY_OPTIONS },
    }),
  })
}

// Singleton — survives HMR via globalThis
const globals = globalThis as Record<string, unknown>

function current(): pino.Logger {
  return (globals.__wystack_logger__ ??= createDefaultLogger()) as pino.Logger
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
  return new Proxy({} as pino.Logger, {
    get(_target, prop, receiver) {
      const child = current().child({ component: name })
      const val = Reflect.get(child, prop, receiver)
      return typeof val === 'function' ? val.bind(child) : val
    },
  })
}

/** Initialize logging with full config (ring buffer, file transport, redaction). */
export function initTracey(config: TraceyConfig) {
  const isPretty = process.env.LOG_PRETTY === '1' || (isDev && process.stdout.isTTY)
  const level = config.level ?? process.env.LOG_LEVEL ?? (isDev ? 'debug' : 'info')

  const streams: pino.StreamEntry[] = []

  // Pretty or JSON stdout
  if (isPretty) {
    streams.push({
      level: level as pino.Level,
      stream: pino.transport({ target: 'pino-pretty', options: PINO_PRETTY_OPTIONS }),
    })
  } else {
    streams.push({ level: level as pino.Level, stream: process.stdout })
  }

  // Ring buffer
  const ringSize = config.ringBuffer ?? DEFAULT_RING_SIZE
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
  } else {
    clearRingBuffer()
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

  globals.__wystack_logger__ = pino(opts, pino.multistream(streams))
}
