import { getTableName } from 'drizzle-orm'
import { tryGetTableCapabilities } from './schema'
import type {
  AnyTable,
  DraftDrizzleTracker,
  DrizzleDb,
  DrizzleTracker,
  TenantScope,
  TransactionOptions,
} from './tracker-core'
import {
  assertRevisionInput,
  assertTenantInput,
  emptyClauses,
  noTenantScope,
  requireTenantScope,
  revisionProperty,
  tableTrackingTag,
  withoutUndefined,
} from './tracker-core'
import { SelectBuilder } from './select-builder'
import { DraftSelectBuilder } from './draft-select-builder'
import { DraftInsertBuilder } from './draft-mutations'
import { allocateRowRevision } from './row-revisions'

export class InsertBuilder<T extends AnyTable> {
  private _table: T
  private _db: DrizzleDb
  private _tracker: DrizzleTracker
  private _tenantScope: TenantScope

  constructor(table: T, db: DrizzleDb, tracker: DrizzleTracker, tenantScope: TenantScope) {
    this._table = table
    this._db = db
    this._tracker = tracker
    this._tenantScope = tenantScope
  }

  async insert(values: T['$inferInsert'] | T['$inferInsert'][]) {
    const rows = Array.isArray(values) ? values : [values]
    const tenant = requireTenantScope(this._table, this._tenantScope)
    const revision = revisionProperty(this._table)
    const scopedRows = rows.map((row) => {
      const record = row as Record<string, unknown>
      assertTenantInput(this._table, record)
      assertRevisionInput(this._table, record)
      const sanitized = withoutUndefined(record)
      return tenant ? { ...sanitized, [tenant.tenancy.property]: tenant.tenantId } : sanitized
    })
    const inserted = revision
      ? await this._db.transaction(async (tx: DrizzleDb) => {
          const rowsWithRevisions = []
          for (const row of scopedRows) {
            const token = await allocateRowRevision(tx, this._table, this._tenantScope, row)
            rowsWithRevisions.push({ ...row, [revision]: token })
          }
          return tx.insert(this._table).values(rowsWithRevisions).returning()
        })
      : await this._db.insert(this._table).values(scopedRows).returning()
    this._tracker.tablesWritten.add(tableTrackingTag(this._table, this._tenantScope))
    return inserted
  }
}

export function createDrizzleTracker(
  drizzleDb: DrizzleDb,
  tenantScope: TenantScope = noTenantScope,
  sharedTracking?: { tablesRead: Set<string>; tablesWritten: Set<string> },
): DrizzleTracker {
  const tracker: DrizzleTracker = {
    tablesRead: sharedTracking?.tablesRead ?? new Set(),
    tablesWritten: sharedTracking?.tablesWritten ?? new Set(),
    raw: drizzleDb,
    tenantId: tenantScope === noTenantScope ? undefined : tenantScope,
    from<T extends AnyTable>(table: T) {
      return new SelectBuilder(table, drizzleDb, tracker, tenantScope)
    },
    into<T extends AnyTable>(table: T) {
      return new InsertBuilder(table, drizzleDb, tracker, tenantScope)
    },
    withTenant(tenantId: unknown) {
      if (tenantId === null || tenantId === undefined) {
        throw new Error('withTenant() requires a non-null trusted tenant ID')
      }
      if (tenantScope !== noTenantScope && tenantScope !== tenantId) {
        throw new Error('A tenant-scoped database handle cannot change tenant scope')
      }
      if (tenantScope === tenantId) return tracker
      return createDrizzleTracker(drizzleDb, tenantId, {
        tablesRead: tracker.tablesRead,
        tablesWritten: tracker.tablesWritten,
      })
    },
    withDraft(draftId: string): DraftDrizzleTracker {
      const draftHandle: DraftDrizzleTracker = {
        tablesRead: tracker.tablesRead,
        tablesWritten: tracker.tablesWritten,
        raw: drizzleDb,
        from<T extends AnyTable>(table: T) {
          const capabilities = tryGetTableCapabilities(table)
          const isTenantReadingGlobal = tenantScope !== noTenantScope && !capabilities?.tenancy
          if (capabilities?.draftable === false || isTenantReadingGlobal) {
            const writeError = isTenantReadingGlobal
              ? `Tenant-scoped drafts cannot write global table "${getTableName(table)}"`
              : `Table "${getTableName(table)}" is not draftable; declare it with .draftable() before writing through withDraft()`
            return new SelectBuilder(
              table,
              drizzleDb,
              tracker,
              tenantScope,
              emptyClauses(),
              writeError,
            ) as unknown as DraftSelectBuilder<T>
          }
          return new DraftSelectBuilder(table, drizzleDb, draftId, draftHandle, tenantScope)
        },
        into<T extends AnyTable>(table: T) {
          if (tryGetTableCapabilities(table)?.draftable === false) {
            throw new Error(
              `Table "${getTableName(table)}" is not draftable; declare it with .draftable() before writing through withDraft()`,
            )
          }
          return new DraftInsertBuilder(table, drizzleDb, draftId, draftHandle, tenantScope)
        },
        transaction<R>(
          _fn: (tx: DrizzleTracker) => Promise<R>,
          _opts?: TransactionOptions,
        ): Promise<R> {
          // ProcedureDb exposes transaction() on both canonical and draft handles.
          // A draft handler cannot nest a transaction; lifecycle append and
          // publish own their respective outer operation boundaries.
          throw new Error(
            'DraftDrizzleTracker.transaction() is not supported: a draft handler cannot open its own ' +
              'transaction — lifecycle `append` and `publish` own the draft operation transactions.',
          )
        },
      }
      return draftHandle
    },
    async transaction<R>(
      fn: (tx: DrizzleTracker) => Promise<R>,
      opts?: TransactionOptions,
    ): Promise<R> {
      // The lowering owns atomicity: Drizzle's native transaction provides the
      // tx handle and commits/rolls back. We add Tag-tracking by wrapping that
      // handle in a fresh DrizzleTracker. If `fn` throws, calls rollback, or the
      // COMMIT itself fails, the native transaction rejects this await before
      // the merge below runs — so a non-committed transaction merges nothing
      // and emits no Tags. The merge-after-await placement IS the guarantee;
      // there is deliberately no `committed` flag to drift out of sync.
      let inner: DrizzleTracker | undefined
      const result = await drizzleDb.transaction(async (txHandle: DrizzleDb) => {
        inner = createDrizzleTracker(txHandle, tenantScope)
        return fn(inner)
      }, opts)
      // Reached only on commit. Flush the transaction's accumulated Tags up to
      // the caller's tracker (the call-scope set that reaches invalidation).
      // tablesRead is merged too (intentional): a tx that reads to compute a
      // write contributes those reads to the call's read-set, same as a
      // non-transactional handler would.
      if (inner) {
        for (const t of inner.tablesRead) tracker.tablesRead.add(t)
        for (const t of inner.tablesWritten) tracker.tablesWritten.add(t)
      }
      return result
    },
  }
  return tracker
}

/** Create a fresh DrizzleTracker that shares the same Drizzle connection but with empty tracking sets */
export function resetTracking(tracked: DrizzleTracker): DrizzleTracker {
  return tracked.tenantId === undefined
    ? createDrizzleTracker(tracked.raw)
    : createDrizzleTracker(tracked.raw, tracked.tenantId)
}
