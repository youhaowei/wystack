import { useTestPglite } from '@wystack/db/testing'

export function useSharedHarness(): void {
  useTestPglite()
}
