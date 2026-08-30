import { describe, expect, test } from 'bun:test'
import { getTableConfig, pgTable, primaryKey, text as pgText } from 'drizzle-orm/pg-core'
import { defineSchema } from '../schema'
import { text } from '../dsl'
import { multiTenant } from '../table'
import { resolvePkColumnName } from '../tracker-codecs'

describe('primary-key codec resolution', () => {
  test('uses the logical identity from a framework tenant composite primary key', () => {
    const tenancy = multiTenant({
      key: { property: 'workspaceId', column: 'workspace_id', type: text },
    })
    const schema = defineSchema({
      records: tenancy.table({ recordKey: text.primaryKey(), value: text }).draftable(),
    })

    expect(resolvePkColumnName(schema.records, getTableConfig(schema.records))).toBe('recordKey')
  })

  test('continues to reject arbitrary composite primary keys', () => {
    const memberships = pgTable(
      'memberships',
      {
        accountId: pgText('account_id').notNull(),
        userId: pgText('user_id').notNull(),
      },
      (membership) => [primaryKey({ columns: [membership.accountId, membership.userId] })],
    )

    expect(() => resolvePkColumnName(memberships, getTableConfig(memberships))).toThrow(
      'Composite PKs are not supported',
    )
  })
})
