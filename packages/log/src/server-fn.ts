import { WideEvent } from './wide-event'

interface HandlerContext<T> {
  data: T
}

interface LoggingOptions {
  name: string
  method?: 'GET' | 'POST'
}

export function withLogging<TInput, TOutput>(
  opts: LoggingOptions,
  handler: (ctx: HandlerContext<TInput>, event: WideEvent) => Promise<TOutput>,
) {
  return async (ctx: HandlerContext<TInput>): Promise<TOutput> => {
    const event = new WideEvent(`server.${opts.name}`)
    event.set({
      fn_name: opts.name,
      fn_method: opts.method,
    })

    // Extract orgId if present in data
    const data = ctx.data as Record<string, unknown>
    if (data && typeof data.orgId === 'string') {
      event.set({ org_id: data.orgId })
    }

    try {
      const result = await handler(ctx, event)

      // Auto-detect result count for arrays
      if (Array.isArray(result)) {
        event.set({ result_count: result.length })
      }

      event.set({ outcome: 'success' })
      return result
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      event.set({
        outcome: 'error',
        error_type: err.name,
        error_message: err.message,
      })
      throw error
    } finally {
      event.flush()
    }
  }
}
