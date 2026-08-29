/**
 * Deterministically encode JSON-like values for equality and identity keys.
 * Dates retain an explicit tag so an instant never compares equal to its ISO
 * string representation.
 */
export function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (value instanceof Date) return `date:${JSON.stringify(value.toJSON())}`
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`
}
