import { describe, test, expect } from 'bun:test'
import { defineSchema } from '../schema'
import { text, int, boolean, timestamp } from '../dsl'
import { getTableName, getTableColumns } from 'drizzle-orm'

describe('defineSchema', () => {
  test('produces a Drizzle pgTable for each table', () => {
    const schema = defineSchema({
      todos: {
        id: int.primaryKey(),
        title: text,
        done: boolean,
      },
    })

    expect(schema.todos).toBeDefined()
    expect(getTableName(schema.todos)).toBe('todos')
  })

  test('maps column types correctly', () => {
    const schema = defineSchema({
      items: {
        id: int.primaryKey(),
        name: text,
        active: boolean,
        createdAt: timestamp,
      },
    })

    const cols = getTableColumns(schema.items)
    expect(cols.id).toBeDefined()
    expect(cols.name).toBeDefined()
    expect(cols.active).toBeDefined()
    expect(cols.createdAt).toBeDefined()
  })

  test('optional columns are nullable', () => {
    const schema = defineSchema({
      items: {
        id: int.primaryKey(),
        description: text.optional(),
      },
    })

    const cols = getTableColumns(schema.items)
    // notNull is false for optional columns
    expect(cols.description.notNull).toBe(false)
  })

  test('non-optional columns are notNull', () => {
    const schema = defineSchema({
      items: {
        id: int.primaryKey(),
        name: text,
      },
    })

    const cols = getTableColumns(schema.items)
    expect(cols.name.notNull).toBe(true)
  })

  test('unique constraint is applied', () => {
    const schema = defineSchema({
      users: {
        id: int.primaryKey(),
        email: text.unique(),
      },
    })

    const cols = getTableColumns(schema.users)
    expect(cols.email.isUnique).toBe(true)
  })

  test('multiple tables can be defined', () => {
    const schema = defineSchema({
      users: {
        id: int.primaryKey(),
        name: text,
      },
      posts: {
        id: int.primaryKey(),
        title: text,
        authorId: int,
      },
    })

    expect(getTableName(schema.users)).toBe('users')
    expect(getTableName(schema.posts)).toBe('posts')
  })
})
