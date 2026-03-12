/**
 * Filter operators for TrackedDb queries.
 * Produce descriptors that TrackedDb translates to Drizzle SQL conditions.
 */

export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'

export interface FilterDescriptor<T = unknown> {
  op: FilterOp
  column: string
  value: T
}

export function eq<T>(column: string, value: T): FilterDescriptor<T> {
  return { op: 'eq', column, value }
}

export function ne<T>(column: string, value: T): FilterDescriptor<T> {
  return { op: 'ne', column, value }
}

export function gt<T>(column: string, value: T): FilterDescriptor<T> {
  return { op: 'gt', column, value }
}

export function gte<T>(column: string, value: T): FilterDescriptor<T> {
  return { op: 'gte', column, value }
}

export function lt<T>(column: string, value: T): FilterDescriptor<T> {
  return { op: 'lt', column, value }
}

export function lte<T>(column: string, value: T): FilterDescriptor<T> {
  return { op: 'lte', column, value }
}
