import { describe, test, expect } from 'bun:test'
import { defineSchema } from '../schema'
import { text, int, boolean, timestamp, uuid, jsonb } from '../dsl'
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

  test('uuid column with defaultRandom', () => {
    const schema = defineSchema({
      items: {
        id: uuid.primaryKey().defaultRandom(),
        name: text,
      },
    })

    const cols = getTableColumns(schema.items)
    expect(cols.id).toBeDefined()
    expect(cols.id.hasDefault).toBe(true)
  })

  test('timestamp with defaultNow', () => {
    const schema = defineSchema({
      items: {
        id: uuid.primaryKey().defaultRandom(),
        createdAt: timestamp.defaultNow(),
      },
    })

    const cols = getTableColumns(schema.items)
    expect(cols.createdAt.hasDefault).toBe(true)
  })

  test('text array column', () => {
    const schema = defineSchema({
      settings: {
        id: uuid.primaryKey().defaultRandom(),
        tags: text.array().default([]),
      },
    })

    const cols = getTableColumns(schema.settings)
    expect(cols.tags).toBeDefined()
  })

  test('foreign key references', () => {
    const schema = defineSchema({
      users: {
        id: uuid.primaryKey().defaultRandom(),
        name: text,
      },
      posts: {
        id: uuid.primaryKey().defaultRandom(),
        title: text,
        authorId: uuid.optional().references('users'),
      },
    })

    expect(getTableName(schema.users)).toBe('users')
    expect(getTableName(schema.posts)).toBe('posts')
    const cols = getTableColumns(schema.posts)
    expect(cols.authorId).toBeDefined()
  })

  test('WorkHub-like schema with uuid, refs, and defaults', () => {
    const schema = defineSchema({
      users: {
        id: uuid.primaryKey().defaultRandom(),
        orgId: text,
        clerkUserId: text.unique(),
        name: text.optional(),
        email: text.optional(),
        createdAt: timestamp.defaultNow(),
        updatedAt: timestamp.defaultNow(),
      },
      people: {
        id: uuid.primaryKey().defaultRandom(),
        orgId: text,
        name: text,
        email: text.optional(),
        createdById: uuid.optional().references('users'),
        createdAt: timestamp.defaultNow(),
        updatedAt: timestamp.defaultNow(),
      },
      activityLog: {
        id: uuid.primaryKey().defaultRandom(),
        orgId: text,
        targetModel: text,
        targetId: uuid,
        userId: uuid.optional().references('users'),
        action: text,
        changes: jsonb.optional(),
        createdAt: timestamp.defaultNow(),
      },
    })

    expect(getTableName(schema.users)).toBe('users')
    expect(getTableName(schema.people)).toBe('people')
    expect(getTableName(schema.activityLog)).toBe('activity_log')

    const peopleCols = getTableColumns(schema.people)
    expect(peopleCols.orgId.name).toBe('org_id')
    expect(peopleCols.createdById.name).toBe('created_by_id')
    expect(peopleCols.createdAt.name).toBe('created_at')

    const activityCols = getTableColumns(schema.activityLog)
    expect(activityCols.targetModel.name).toBe('target_model')
    expect(activityCols.targetId.name).toBe('target_id')
    expect(activityCols.createdAt.name).toBe('created_at')
  })
})
