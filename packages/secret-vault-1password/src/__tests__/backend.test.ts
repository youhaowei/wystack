import { describe, expect, test } from 'bun:test'
import {
  AuthExpiredError,
  ItemCategory,
  ItemFieldType,
  ItemState,
  RateLimitExceededError,
  type Item,
  type ItemCreateParams,
  type ItemOverview,
} from '@1password/sdk'
import { InMemoryMappingStore, SecretRegistry, SecretVault } from '@wystack/secret-vault'
import {
  OnePasswordBackend,
  OnePasswordBackendError,
  OnePasswordOwnershipError,
  type OnePasswordItemsClient,
} from '../index'

class FakeOnePasswordItems implements OnePasswordItemsClient {
  readonly items = new Map<string, Item>()
  getCalls = 0
  listCalls = 0
  #nextId = 1

  async create(params: ItemCreateParams): Promise<Item> {
    const now = new Date('2026-08-16T00:00:00.000Z')
    const item: Item = {
      id: `item-${this.#nextId++}`,
      title: params.title,
      category: params.category,
      vaultId: params.vaultId,
      fields: params.fields ?? [],
      sections: params.sections ?? [],
      notes: params.notes ?? '',
      tags: params.tags ?? [],
      websites: params.websites ?? [],
      version: 1,
      files: [],
      createdAt: now,
      updatedAt: now,
    }
    this.items.set(item.id, item)
    return item
  }

  async get(vaultId: string, itemId: string): Promise<Item> {
    this.getCalls++
    const item = this.items.get(itemId)
    if (!item || item.vaultId !== vaultId) throw new Error('item not found')
    return item
  }

  async list(vaultId: string): Promise<ItemOverview[]> {
    this.listCalls++
    return [...this.items.values()]
      .filter((item) => item.vaultId === vaultId)
      .map((item) => ({
        id: item.id,
        title: item.title,
        category: item.category,
        vaultId: item.vaultId,
        websites: item.websites,
        tags: item.tags,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        state: ItemState.Active,
      }))
  }

  async delete(vaultId: string, itemId: string): Promise<void> {
    const item = this.items.get(itemId)
    if (!item || item.vaultId !== vaultId) throw new Error('item not found')
    this.items.delete(itemId)
  }
}

function makeVault(items = new FakeOnePasswordItems()): {
  backend: OnePasswordBackend
  items: FakeOnePasswordItems
  vault: SecretVault
} {
  const backend = new OnePasswordBackend({ items, writeVaultId: 'development' })
  const registry = new SecretRegistry()
  registry.register('1password', backend)
  registry.setClassDefault('connector-key', '1password')
  return {
    backend,
    items,
    vault: new SecretVault(registry, new InMemoryMappingStore()),
  }
}

describe('OnePasswordBackend prototype', () => {
  test('stores and uses a managed secret through the SecretVault interface', async () => {
    const { items, vault } = makeVault()

    const ref = await vault.store('sk_demo_secret', {
      class: 'connector-key',
      locatorHint: 'Stripe',
    })

    expect(await vault.has(ref)).toBe(true)
    expect(await vault.withSecret(ref, async (secret) => secret.length)).toBe(14)

    const [item] = [...items.items.values()]
    expect(item?.title).toBe('WyStack · Stripe')
    expect(item?.category).toBe(ItemCategory.Password)
    expect(item?.fields).toEqual([
      {
        id: 'password',
        title: 'credential',
        fieldType: ItemFieldType.Concealed,
        value: 'sk_demo_secret',
      },
    ])
  })

  test('rejects a malformed ownership tag before calling 1Password', async () => {
    const { backend, items } = makeVault()
    const forgedLocator = JSON.stringify({
      version: 1,
      vaultId: 'development',
      itemId: 'external-item',
      ownerTag: 'wystack-owner:',
    })

    await expect(backend.has(forgedLocator)).rejects.toThrow('Invalid locator')
    expect(items.listCalls).toBe(0)
    expect(items.getCalls).toBe(0)
  })

  test('checks presence through item overviews without retrieving credential fields', async () => {
    const { backend, items } = makeVault()
    const locator = await backend.store('secret')

    expect(await backend.has(locator)).toBe(true)
    expect(items.listCalls).toBe(1)
    expect(items.getCalls).toBe(0)
  })

  test('classifies rate limits without retrying the provider operation', async () => {
    const items = new FakeOnePasswordItems()
    const rateLimit = new RateLimitExceededError('slow down')
    items.list = async () => {
      items.listCalls++
      throw rateLimit
    }
    const { backend } = makeVault(items)
    const locator = await backend.store('secret')

    const rejection = backend.has(locator)
    await expect(rejection).rejects.toBeInstanceOf(OnePasswordBackendError)
    await expect(rejection).rejects.toMatchObject({
      kind: 'rate-limit',
      operation: 'has',
      retryable: true,
      cause: rateLimit,
    })
    expect(items.listCalls).toBe(1)
  })

  test('classifies expired authentication as non-retryable by the adapter', async () => {
    const items = new FakeOnePasswordItems()
    const authExpired = new AuthExpiredError('authenticate again')
    items.create = async () => {
      throw authExpired
    }
    const { backend } = makeVault(items)

    await expect(backend.store('secret')).rejects.toMatchObject({
      kind: 'authentication',
      operation: 'store',
      retryable: false,
      cause: authExpired,
    })
  })

  test('does not disguise errors thrown by the secret callback as provider failures', async () => {
    const { backend } = makeVault()
    const locator = await backend.store('secret')
    const callbackError = new Error('consumer failed')

    await expect(
      backend.withSecret(locator, async () => {
        throw callbackError
      }),
    ).rejects.toBe(callbackError)
  })

  test('refuses to delete an item whose ownership tag no longer matches', async () => {
    const { backend, items } = makeVault()
    const locator = await backend.store('secret')
    const [item] = [...items.items.values()]
    if (!item) throw new Error('fixture did not create an item')
    item.tags = []

    await expect(backend.delete(locator)).rejects.toBeInstanceOf(OnePasswordOwnershipError)
    expect(items.items.has(item.id)).toBe(true)
  })

  test('deletes the managed item and mapping through SecretVault', async () => {
    const { items, vault } = makeVault()
    const ref = await vault.store('secret', { class: 'connector-key' })

    await vault.delete(ref)

    expect(items.items.size).toBe(0)
    expect(await vault.has(ref)).toBe(false)
  })
})
