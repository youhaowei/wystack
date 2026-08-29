export interface CanonicalIdentity {
  value: unknown
  text: string
}

/** Canonical database identity shared by tenant scope, draft keys, and revisions. */
export function canonicalizeIdentity(type: string, rawValue: unknown): CanonicalIdentity {
  const normalized = type.toLowerCase()
  if (rawValue === null || rawValue === undefined) {
    throw invalidIdentity(normalized, rawValue)
  }
  if (normalized === 'uuid') {
    const source = String(rawValue)
    const opensBrace = source.startsWith('{')
    const closesBrace = source.endsWith('}')
    if (opensBrace !== closesBrace) throw invalidIdentity('UUID', rawValue)
    const unwrapped = opensBrace ? source.slice(1, -1) : source
    const groups = unwrapped.split('-')
    const validGroups = groups.every(
      (group) => group.length > 0 && group.length % 4 === 0 && /^[0-9a-fA-F]+$/.test(group),
    )
    const digits = groups.join('')
    if (!validGroups || digits.length !== 32) throw invalidIdentity('UUID', rawValue)
    const value = [
      digits.slice(0, 8),
      digits.slice(8, 12),
      digits.slice(12, 16),
      digits.slice(16, 20),
      digits.slice(20),
    ]
      .join('-')
      .toLowerCase()
    return { value, text: value }
  }

  if (normalized === 'integer' || normalized === 'bigint' || normalized === 'smallint') {
    const match = /^[\t\n\v\f\r ]*([+-]?\d+)[\t\n\v\f\r ]*$/.exec(String(rawValue))
    if (!match) throw invalidIdentity(normalized, rawValue)
    const integer = BigInt(match[1])
    const [minimum, maximum] =
      normalized === 'smallint'
        ? [-32_768n, 32_767n]
        : normalized === 'integer'
          ? [-2_147_483_648n, 2_147_483_647n]
          : [-9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n]
    if (integer < minimum || integer > maximum) throw invalidIdentity(normalized, rawValue)
    const text = integer.toString()
    const numeric = Number(text)
    return { value: Number.isSafeInteger(numeric) ? numeric : text, text }
  }

  if (normalized === 'text' || /^varchar(?:\(\d+\))?$/.test(normalized)) {
    const text = String(rawValue)
    return { value: text, text }
  }
  throw new Error(
    `Draft identity columns must be scalar int, text, or uuid; received ${normalized}`,
  )
}

function invalidIdentity(type: string, value: unknown): Error {
  const formatted = typeof value === 'string' ? JSON.stringify(value) : String(value)
  return new Error(`Invalid ${type} identity: ${formatted}`)
}
