export function createSubscriptionIdAllocator(createId: () => string) {
  const activeIds = new Set<string>()

  return {
    allocate(): string {
      const requestedId = createId()
      let id = requestedId
      let suffix = 0
      while (activeIds.has(id)) id = `${requestedId}_${++suffix}`
      activeIds.add(id)
      return id
    },
    release(id: string): void {
      activeIds.delete(id)
    },
  }
}
