function createDb(config: { dev: string }) {
  return config
}

export const local = createDb({ dev: 'pglite://' })
