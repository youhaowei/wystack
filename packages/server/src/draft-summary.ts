import { snapshotJsonValue } from './draft-command-log'
import {
  MAX_DRAFT_SUMMARY_BYTES,
  MAX_DRAFT_SUMMARY_DEPTH,
  type DraftSummary,
} from './draft-lifecycle-types'

function assertDraftSummaryDepth(value: unknown, path: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current || current.value === null || typeof current.value !== 'object') continue
    if (current.value instanceof Date) continue
    const depth = current.depth + 1
    if (depth > MAX_DRAFT_SUMMARY_DEPTH) {
      throw new Error(
        `draft lifecycle: ${path} must not exceed ${MAX_DRAFT_SUMMARY_DEPTH} nested containers`,
      )
    }
    for (const key of Reflect.ownKeys(current.value)) {
      if (typeof key !== 'string') continue
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key)
      if (descriptor && 'value' in descriptor) {
        stack.push({ value: descriptor.value, depth })
      }
    }
  }
}

/** Canonicalize and enforce discovery-safe bounds before durable persistence. */
export function snapshotDraftSummary(value: unknown, path = 'draft summary'): DraftSummary {
  assertDraftSummaryDepth(value, path)
  const summary = snapshotJsonValue(value, path)
  if (summary === undefined) {
    throw new Error(`draft lifecycle: ${path} must be an explicit JSON value`)
  }
  assertDraftSummaryDepth(summary, path)
  const serialized = JSON.stringify(summary)
  const byteLength = new TextEncoder().encode(serialized).byteLength
  if (byteLength > MAX_DRAFT_SUMMARY_BYTES) {
    throw new Error(
      `draft lifecycle: ${path} must not exceed ${MAX_DRAFT_SUMMARY_BYTES} serialized UTF-8 bytes`,
    )
  }
  return summary as DraftSummary
}
