/**
 * Derives Zod schemas from ColumnDef arg descriptors for runtime validation.
 * Schemas are built once at registration time and cached — not per-call.
 */
import { z } from 'zod'
import type { AnyColumnDef } from '@wystack/db'

function columnToZod(col: AnyColumnDef): z.ZodType {
  const { type, isOptional, isArray, hasDefault } = col.opts

  let schema: z.ZodType
  switch (type) {
    case 'text':
      schema = z.string()
      break
    case 'uuid':
      schema = z.uuid()
      break
    case 'int':
      schema = z.number().int()
      break
    case 'boolean':
      schema = z.boolean()
      break
    case 'timestamp':
      schema = z.coerce.date()
      break
    case 'jsonb':
      schema = z.unknown()
      break
    default:
      throw new Error(`Unsupported column type for arg validation: "${type}"`)
  }

  if (isArray) schema = z.array(schema)
  if (isOptional) schema = schema.optional()
  if (hasDefault) {
    schema = schema.optional()
    // Only apply Zod default for explicit values — DB-level defaults
    // (defaultRandom, defaultNow) are handled by the database, not Zod
    if (col.opts.defaultValue !== undefined) schema = schema.default(col.opts.defaultValue)
  }

  return schema
}

export function buildArgsSchema(args: Record<string, AnyColumnDef>): z.ZodType {
  // `Object.create(null)` rather than `{}`: arg names come from the author's
  // `.input({...})` descriptor, and nothing rejects reserved object names (see
  // caller.ts for the same defect class — `shape['__proto__'] = ...` on a
  // normal object invokes the legacy prototype setter instead of creating an
  // own property).
  const shape: Record<string, z.ZodType> = Object.create(null)
  for (const [key, col] of Object.entries(args)) {
    shape[key] = columnToZod(col)
  }
  return z.object(shape)
}

export class ValidationError extends Error {
  issues: z.core.$ZodIssue[]

  constructor(issues: z.core.$ZodIssue[]) {
    const summary = issues.map((i) => `${i.path?.join('.') ?? ''}: ${i.message}`).join('; ')
    super(`Validation failed: ${summary}`)
    this.name = 'ValidationError'
    this.issues = issues
  }
}
