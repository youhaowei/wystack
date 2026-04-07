export interface WideEventFields {
  // Request context
  event_name: string
  timestamp: string
  duration_ms: number

  // Server function context
  fn_name?: string
  fn_method?: 'GET' | 'POST'
  org_id?: string
  outcome?: 'success' | 'error'

  // DB context
  db_init_ms?: number
  db_query_ms?: number
  db_migration_ms?: number
  db_driver?: string
  db_cached?: boolean

  // Business context
  result_count?: number
  entity_type?: string
  entity_id?: string
  action?: string

  // Error context
  error_type?: string
  error_message?: string
  error_code?: string

  // Catch-all for domain-specific fields
  [key: string]: unknown
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'

export interface TraceyConfig {
  level?: LogLevel
  redact?: boolean
  ringBuffer?: number | false
}

export interface LogEntry {
  level: number
  time: number
  component?: string
  msg: string
  [key: string]: unknown
}
