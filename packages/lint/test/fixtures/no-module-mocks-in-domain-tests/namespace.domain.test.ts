import * as Vitest from 'vite-plus/test'

Vitest.vi.mock('../database', () => ({ read: () => [] }))
