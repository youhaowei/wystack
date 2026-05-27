/**
 * Internal tagged-error taxonomy for @wystack/server.
 *
 * These types are INTERNAL — they never appear in any export from index.ts.
 * Effect-shaped handlers fail with these; at the public boundary (HTTP response
 * builder, WS frame sender) the tag is mapped to a wire-shape `{ code: string }`
 * or HTTP status, and the Effect runtime is invoked via `Effect.runPromise` /
 * `Effect.either`. The boundary check in SPIKE-EVAL.md Q4 verifies no `effect/*`
 * imports appear in `dist/index.d.ts`.
 *
 * AuthError       — resolveContext rejected the token, or pre-auth protocol violation.
 * ValidationError — args failed Zod validation. Carries `issues` for the wire `issues` field.
 * TransportError  — ws.send threw post-close, or transport flake during ack.
 * RuntimeError    — anything the user handler threw, or unknown server-internal error.
 */
import { Data } from 'effect'
import type { z } from 'zod'

export class AuthError extends Data.TaggedError('AuthError')<{
  readonly reason: string
  readonly cause?: unknown
}> {}

export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly message: string
  readonly issues: z.core.$ZodIssue[]
}> {}

export class TransportError extends Data.TaggedError('TransportError')<{
  readonly reason: string
  readonly cause?: unknown
}> {}

export class RuntimeError extends Data.TaggedError('RuntimeError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

export type ServerError = AuthError | ValidationError | TransportError | RuntimeError

/** Best-effort message extraction from an unknown thrown value. */
export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
