/**
 * Filter operators for DrizzleTracker queries.
 * Produce descriptors that DrizzleTracker translates to Drizzle SQL conditions.
 */

export type ComparisonFilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
export type MembershipFilterOp = 'in' | 'notIn'
export type NullFilterOp = 'isNull' | 'isNotNull'
export type LogicalFilterOp = 'and' | 'or'
export type FilterOp = ComparisonFilterOp | MembershipFilterOp | NullFilterOp | LogicalFilterOp

export interface ComparisonFilterDescriptor<T = unknown> {
  op: ComparisonFilterOp
  column: string
  value: T
}

export interface MembershipFilterDescriptor<T = unknown> {
  op: MembershipFilterOp
  column: string
  values: readonly T[]
}

export interface NullFilterDescriptor {
  op: NullFilterOp
  column: string
}

export interface LogicalFilterDescriptor {
  op: LogicalFilterOp
  filters: readonly FilterDescriptor[]
}

export type FilterDescriptor<T = unknown> =
  | ComparisonFilterDescriptor<T>
  | MembershipFilterDescriptor<T>
  | NullFilterDescriptor
  | LogicalFilterDescriptor

export function eq<T>(column: string, value: T): ComparisonFilterDescriptor<T> {
  return { op: 'eq', column, value }
}

export function ne<T>(column: string, value: T): ComparisonFilterDescriptor<T> {
  return { op: 'ne', column, value }
}

export function gt<T>(column: string, value: T): ComparisonFilterDescriptor<T> {
  return { op: 'gt', column, value }
}

export function gte<T>(column: string, value: T): ComparisonFilterDescriptor<T> {
  return { op: 'gte', column, value }
}

export function lt<T>(column: string, value: T): ComparisonFilterDescriptor<T> {
  return { op: 'lt', column, value }
}

export function lte<T>(column: string, value: T): ComparisonFilterDescriptor<T> {
  return { op: 'lte', column, value }
}

export function inArray<T>(column: string, values: readonly T[]): MembershipFilterDescriptor<T> {
  return { op: 'in', column, values }
}

export function notInArray<T>(column: string, values: readonly T[]): MembershipFilterDescriptor<T> {
  return { op: 'notIn', column, values }
}

export function isNull(column: string): NullFilterDescriptor {
  return { op: 'isNull', column }
}

export function isNotNull(column: string): NullFilterDescriptor {
  return { op: 'isNotNull', column }
}

function logical(
  op: LogicalFilterOp,
  filters: readonly [FilterDescriptor, ...FilterDescriptor[]],
): LogicalFilterDescriptor {
  if (filters.length === 0) throw new Error(`${op}() requires at least one predicate`)
  return { op, filters }
}

export function and(
  ...filters: readonly [FilterDescriptor, ...FilterDescriptor[]]
): LogicalFilterDescriptor {
  return logical('and', filters)
}

export function or(
  ...filters: readonly [FilterDescriptor, ...FilterDescriptor[]]
): LogicalFilterDescriptor {
  return logical('or', filters)
}
