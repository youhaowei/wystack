import {
  AuthExpiredError,
  DesktopSessionExpiredError,
  ItemCategory,
  ItemFieldType,
  RateLimitExceededError,
  type Client,
  type Item,
} from '@1password/sdk'
import type { SecretBackend } from '@wystack/secret-vault'

const CREDENTIAL_FIELD_ID = 'password'
const OWNER_TAG_PREFIX = 'wystack-owner:'
const OWNER_TAG_RE =
  /^wystack-owner:[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i

interface LocatorV1 {
  readonly version: 1
  readonly vaultId: string
  readonly itemId: string
  readonly ownerTag: string
}

export type OnePasswordItemsClient = Pick<Client['items'], 'create' | 'get' | 'list' | 'delete'>

export interface OnePasswordBackendOptions {
  /** 1Password item operations from an authenticated SDK client. */
  readonly items: OnePasswordItemsClient
  /** Store-time destination. Existing locators retain their own vault ID. */
  readonly writeVaultId: string
}

export type OnePasswordOperation = 'store' | 'read' | 'has' | 'delete'
export type OnePasswordErrorKind = 'authentication' | 'rate-limit' | 'provider'

export class OnePasswordBackendError extends Error {
  readonly retryable: boolean

  constructor(
    readonly operation: OnePasswordOperation,
    readonly kind: OnePasswordErrorKind,
    cause: unknown,
  ) {
    super(`[secret-vault-1password] ${operation} failed: ${kind}`, { cause })
    this.name = 'OnePasswordBackendError'
    this.retryable = kind === 'rate-limit'
  }
}

export class OnePasswordOwnershipError extends Error {
  constructor(itemId: string) {
    super(`[secret-vault-1password] Item "${itemId}" is not owned by this locator`)
    this.name = 'OnePasswordOwnershipError'
  }
}

function requireNonBlank(name: string, value: string): string {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-blank string`)
  }
  return value
}

function encodeLocator(locator: LocatorV1): string {
  return JSON.stringify(locator)
}

function decodeLocator(value: string): LocatorV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new TypeError('[secret-vault-1password] Invalid locator')
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('vaultId' in parsed) ||
    typeof parsed.vaultId !== 'string' ||
    parsed.vaultId.length === 0 ||
    !('itemId' in parsed) ||
    typeof parsed.itemId !== 'string' ||
    parsed.itemId.length === 0 ||
    !('ownerTag' in parsed) ||
    typeof parsed.ownerTag !== 'string' ||
    !OWNER_TAG_RE.test(parsed.ownerTag)
  ) {
    throw new TypeError('[secret-vault-1password] Invalid locator')
  }

  return {
    version: 1,
    vaultId: parsed.vaultId,
    itemId: parsed.itemId,
    ownerTag: parsed.ownerTag,
  }
}

function assertOwned(item: Pick<Item, 'id' | 'tags'>, ownerTag: string): void {
  if (!item.tags.includes(ownerTag)) {
    throw new OnePasswordOwnershipError(item.id)
  }
}

function classifyProviderError(error: unknown): OnePasswordErrorKind {
  if (error instanceof RateLimitExceededError) return 'rate-limit'
  if (error instanceof AuthExpiredError || error instanceof DesktopSessionExpiredError) {
    return 'authentication'
  }
  return 'provider'
}

async function callProvider<T>(
  operation: OnePasswordOperation,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call()
  } catch (error) {
    throw new OnePasswordBackendError(operation, classifyProviderError(error), error)
  }
}

/**
 * PROTOTYPE adapter that stores one concealed credential per managed 1Password item.
 *
 * It deliberately has no attach operation: every locator is minted from an item this
 * adapter created and carries a per-item ownership tag used to guard reads and deletes.
 */
export class OnePasswordBackend implements SecretBackend {
  readonly #items: OnePasswordItemsClient
  readonly #writeVaultId: string

  constructor(options: OnePasswordBackendOptions) {
    this.#items = options.items
    this.#writeVaultId = requireNonBlank('writeVaultId', options.writeVaultId)
  }

  async store(plaintext: string, locatorHint?: string): Promise<string> {
    const ownerTag = `${OWNER_TAG_PREFIX}${crypto.randomUUID()}`
    const title = locatorHint?.trim() ? `WyStack · ${locatorHint.trim()}` : 'WyStack · Secret'
    const item = await callProvider('store', () =>
      this.#items.create({
        category: ItemCategory.Password,
        vaultId: this.#writeVaultId,
        title,
        tags: [ownerTag],
        fields: [
          {
            id: CREDENTIAL_FIELD_ID,
            title: 'credential',
            fieldType: ItemFieldType.Concealed,
            value: plaintext,
          },
        ],
      }),
    )

    return encodeLocator({
      version: 1,
      vaultId: item.vaultId,
      itemId: item.id,
      ownerTag,
    })
  }

  async withSecret<T>(locatorValue: string, use: (plaintext: string) => Promise<T>): Promise<T> {
    const locator = decodeLocator(locatorValue)
    const item = await callProvider('read', () => this.#items.get(locator.vaultId, locator.itemId))
    assertOwned(item, locator.ownerTag)

    const credential = item.fields.find(
      (field) => field.id === CREDENTIAL_FIELD_ID && field.fieldType === ItemFieldType.Concealed,
    )
    if (!credential) {
      throw new Error(
        `[secret-vault-1password] Managed item "${locator.itemId}" has no concealed credential field`,
      )
    }
    return use(credential.value)
  }

  async has(locatorValue: string): Promise<boolean> {
    const locator = decodeLocator(locatorValue)
    const overviews = await callProvider('has', () => this.#items.list(locator.vaultId))
    const item = overviews.find((candidate) => candidate.id === locator.itemId)
    return item?.tags.includes(locator.ownerTag) ?? false
  }

  async delete(locatorValue: string): Promise<void> {
    const locator = decodeLocator(locatorValue)
    const overviews = await callProvider('delete', () => this.#items.list(locator.vaultId))
    const item = overviews.find((candidate) => candidate.id === locator.itemId)
    if (!item) return
    assertOwned(item, locator.ownerTag)
    await callProvider('delete', () => this.#items.delete(locator.vaultId, locator.itemId))
  }
}
