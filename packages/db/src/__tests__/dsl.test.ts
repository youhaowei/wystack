import { describe, test, expect } from 'bun:test'
import { text, int, boolean, timestamp, jsonb, ColumnDef } from '../dsl'

describe('DSL column builders', () => {
  test('text creates a text column def', () => {
    expect(text.opts.type).toBe('text')
    expect(text.opts.isOptional).toBe(false)
    expect(text.opts.isPrimaryKey).toBe(false)
  })

  test('int creates an int column def', () => {
    expect(int.opts.type).toBe('int')
  })

  test('boolean creates a boolean column def', () => {
    expect(boolean.opts.type).toBe('boolean')
  })

  test('timestamp creates a timestamp column def', () => {
    expect(timestamp.opts.type).toBe('timestamp')
  })

  test('jsonb creates a jsonb column def', () => {
    expect(jsonb.opts.type).toBe('jsonb')
  })

  test('.optional() returns new instance with isOptional=true', () => {
    const col = text.optional()
    expect(col.opts.isOptional).toBe(true)
    // Original is unchanged (immutable)
    expect(text.opts.isOptional).toBe(false)
    expect(col).not.toBe(text)
  })

  test('.default() returns new instance with default value', () => {
    const col = text.default('hello')
    expect(col.opts.hasDefault).toBe(true)
    expect(col.opts.defaultValue).toBe('hello')
    expect(text.opts.hasDefault).toBe(false)
  })

  test('.primaryKey() returns new instance with isPrimaryKey=true', () => {
    const col = int.primaryKey()
    expect(col.opts.isPrimaryKey).toBe(true)
    expect(int.opts.isPrimaryKey).toBe(false)
  })

  test('.unique() returns new instance with isUnique=true', () => {
    const col = text.unique()
    expect(col.opts.isUnique).toBe(true)
    expect(text.opts.isUnique).toBe(false)
  })

  test('modifiers can be chained', () => {
    const col = text.optional().unique().default('x')
    expect(col.opts.isOptional).toBe(true)
    expect(col.opts.isUnique).toBe(true)
    expect(col.opts.hasDefault).toBe(true)
    expect(col.opts.defaultValue).toBe('x')
  })

  test('each modifier produces a ColumnDef instance', () => {
    expect(text.optional()).toBeInstanceOf(ColumnDef)
    expect(int.primaryKey()).toBeInstanceOf(ColumnDef)
    expect(text.unique()).toBeInstanceOf(ColumnDef)
    expect(text.default('x')).toBeInstanceOf(ColumnDef)
  })
})
