import { createClient } from '@1password/sdk'
import { InMemoryMappingStore, SecretRegistry, SecretVault } from '@wystack/secret-vault'
import { OnePasswordBackend } from './index'

function requireLiveVariable(name: string): string {
  const value = Bun.env[name]
  if (!value) throw new Error(`${name} is required`)
  return value
}

if (Bun.env.WYSTACK_1PASSWORD_LIVE_TEST !== '1') {
  throw new Error('Live 1Password smoke test is disabled; set WYSTACK_1PASSWORD_LIVE_TEST=1')
}

const client = await createClient({
  auth: requireLiveVariable('OP_SERVICE_ACCOUNT_TOKEN'),
  integrationName: 'WyStack SecretVault spike',
  integrationVersion: '0.0.1',
})
const backend = new OnePasswordBackend({
  items: client.items,
  writeVaultId: requireLiveVariable('OP_VAULT_ID'),
})
const registry = new SecretRegistry()
registry.register('1password', backend)
registry.setClassDefault('live-probe', '1password')
const vault = new SecretVault(registry, new InMemoryMappingStore())

const probe = `wystack-live-probe:${crypto.randomUUID()}`
const ref = await vault.store(probe, {
  class: 'live-probe',
  locatorHint: 'Disposable live smoke test',
})

try {
  if (!(await vault.has(ref))) throw new Error('stored probe was not present')
  const length = await vault.withSecret(ref, async (secret) => secret.length)
  if (length !== probe.length) throw new Error('resolved probe did not match')
  console.log('1Password SecretVault live smoke passed')
} finally {
  await vault.delete(ref)
}
