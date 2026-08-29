import { getTableConfig } from 'drizzle-orm/pg-core'
import { text } from '../dsl'
import { defineSchema, getGeneratedTables } from '../schema'
import { renderCreateTableIfNotExists } from '../sync'
import { table } from '../table'

const fixtureSchema = defineSchema({
  draftStorageFixture: table({ id: text.primaryKey() }).draftable(),
})

const draftChangesTable = getGeneratedTables(fixtureSchema).find(
  (candidate) => getTableConfig(candidate).name === 'wystack_draft_row_changes',
)

if (!draftChangesTable) {
  throw new Error('Draft storage fixture could not resolve wystack_draft_row_changes')
}

/** Production-derived DDL for tests that exercise low-level draft SQL directly. */
export const draftChangesTableDdl = renderCreateTableIfNotExists(draftChangesTable)
