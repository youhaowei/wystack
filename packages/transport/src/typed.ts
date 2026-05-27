// @wystack/transport — typed pipe wrapper
//
// `wrapTypedPipe` lifts a raw `Pipe<unknown, unknown>` to a `Pipe<In, Out>`
// by composing a runtime parser on the inbound side. Outbound `send` is
// untouched — the `Out` parameter is purely compile-time.
//
// Parser policy is the caller's:
//   - If `parseIn` returns, the typed handler receives the parsed value.
//     Callers that want "drop malformed" can throw inside the parser; the
//     throw propagates out of the inner pipe-handler invocation and never
//     reaches the typed handler.
//   - If `parseIn` throws, the throw propagates (we do not catch). Callers
//     that want to swallow malformed payloads must catch inside the parser
//     and return a sentinel typed value.
//
// `id` and `close` pass straight through to the underlying pipe, so a typed
// view shares identity and lifecycle with the channel beneath it.

import type { Pipe } from './pipe'

export function wrapTypedPipe<In, Out>(pipe: Pipe, parseIn: (raw: unknown) => In): Pipe<In, Out> {
  return {
    get id() {
      return pipe.id
    },
    send(message: Out): void | Promise<void> {
      return pipe.send(message)
    },
    onMessage(handler: (message: In) => void): () => void {
      return pipe.onMessage((raw) => handler(parseIn(raw)))
    },
    close(): void | Promise<void> {
      return pipe.close()
    },
  }
}
