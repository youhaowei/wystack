/**
 * Request-timescale dispatch — pure `dispatch(path, args, context)` with no
 * connection state. Registry resolution stays behind `WyStackApp.call`.
 */
import type { WyStackApp } from '../create'

export interface DispatchResult {
  data: unknown
  tablesRead: Set<string>
  tablesWritten: Set<string>
}

export type DispatchFn = (
  path: string,
  args: unknown,
  context: Record<string, unknown>,
) => Promise<DispatchResult>

export function createDispatch(app: WyStackApp): DispatchFn {
  return async (path, args, context) => {
    const { result, tablesRead, tablesWritten } = await app.call(path, args, context)
    return { data: result, tablesRead, tablesWritten }
  }
}
