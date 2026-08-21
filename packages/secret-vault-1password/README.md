# `@wystack/secret-vault-1password` prototype

Executable spike for using 1Password as a `SecretBackend`.

```ts
import { createClient } from '@1password/sdk'
import { OnePasswordBackend } from '@wystack/secret-vault-1password'

const client = await createClient({
  auth: serviceAccountToken,
  integrationName: 'My WyStack app',
  integrationVersion: '0.1.0',
})

const backend = new OnePasswordBackend({
  items: client.items,
  writeVaultId,
})

registry.register('1password', backend)
registry.setClassDefault('connector-key', '1password')
```

The prototype creates one Password item per secret. Its opaque locator contains the
vault ID, item ID, and a random ownership tag. Reads and deletes require that tag to
still exist on the item, so an arbitrary existing item cannot be attached or deleted.
`delete()` uses the 1Password SDK deletion operation; 1Password's retention policy,
including any recoverable trash state, remains provider-managed.

Provider failures are exposed as `OnePasswordBackendError` with a stable `operation`,
`kind`, and `retryable` flag. The adapter never retries automatically: a timed-out
mutation can have an ambiguous outcome, so retry policy belongs to the caller. The
official authentication and session-expiry errors map to `authentication`; rate limits
map to `rate-limit`; other SDK and network failures map to `provider`.

`has()` uses `items.list()`. The SDK documents `ItemOverview` as decrypted metadata,
but it contains no credential fields. This required tightening the core contract to its
security intent: presence checks may read provider metadata but must never materialise
the credential value.

## Live smoke test

The live test is deliberately disabled unless all three variables are set:

```sh
WYSTACK_1PASSWORD_LIVE_TEST=1 \
OP_SERVICE_ACCOUNT_TOKEN=... \
OP_VAULT_ID=... \
bun run --cwd packages/secret-vault-1password smoke:live
```

It creates a random non-sensitive probe item, verifies the full `SecretVault` round
trip, and deletes the item in `finally`. Do not use a personal vault; use a dedicated
least-privilege development vault.
