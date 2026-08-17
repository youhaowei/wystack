import {
  CLIENT_CONTEXT_HEADER,
  decodeClientContextHeader,
  normalizeClientContext,
  type ClientContext,
} from '@wystack/transport'

export type ValidateClientContext = (
  value: ClientContext,
) => Promise<Record<string, unknown>> | Record<string, unknown>

export class InvalidClientContextError extends Error {
  override readonly name = 'InvalidClientContextError'
}

export function readHttpClientContext(request: Request): unknown {
  const encoded = request.headers.get(CLIENT_CONTEXT_HEADER)
  if (encoded === null) return undefined
  try {
    return decodeClientContextHeader(encoded)
  } catch {
    throw new InvalidClientContextError('Invalid client context JSON')
  }
}

export async function validateIncomingClientContext(
  rawValue: unknown,
  validate?: ValidateClientContext,
): Promise<Readonly<Record<string, unknown>>> {
  let value: ClientContext
  try {
    value = normalizeClientContext(rawValue ?? {})
  } catch {
    throw new InvalidClientContextError('Client context must be a JSON object')
  }

  if (!validate) {
    if (Object.keys(value).length > 0) {
      throw new InvalidClientContextError('Client context is not configured on this server')
    }
    return Object.freeze({})
  }

  let validated: Record<string, unknown>
  try {
    validated = await validate(value)
  } catch (error) {
    throw new InvalidClientContextError(
      error instanceof Error ? error.message : 'Invalid client context',
    )
  }

  if (validated === null || typeof validated !== 'object' || Array.isArray(validated)) {
    throw new InvalidClientContextError('Client context validator must return an object')
  }
  return Object.freeze({ ...validated })
}
