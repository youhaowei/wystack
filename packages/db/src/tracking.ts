/**
 * Read-set tracker. Wraps a db instance to track which tables
 * each query touches, enabling reactive invalidation.
 */
export interface ReadTracker {
  tablesRead: Set<string>
  tablesWritten: Set<string>
}

export function createReadTracker(): ReadTracker {
  return {
    tablesRead: new Set(),
    tablesWritten: new Set(),
  }
}
