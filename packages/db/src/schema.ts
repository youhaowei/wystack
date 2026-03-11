import type { WyStackSchema, TableDef } from './types'

/**
 * Define a WyStack schema. Thin wrapper over Drizzle tables
 * that registers them with the function registry for tracking.
 */
export function defineSchema<T extends Record<string, TableDef>>(tables: T): T & WyStackSchema {
  return tables
}
