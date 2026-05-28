// Minimal port interface for the reactive tier (ADR #12).
// YW-62 defines the full SubscriptionStore + invalidation-source ports.
// This local shape is the minimal surface session.ts needs to remain
// decoupled from the concrete subscriptions.ts implementation.

import type { Subscription } from '../subscriptions'

export interface SubscriptionStore {
  add(sub: Subscription): void
  remove(id: string): void
  get(id: string): Subscription | undefined
  getAffectedSubscriptions(writtenTables: Set<string>): Subscription[]
}
