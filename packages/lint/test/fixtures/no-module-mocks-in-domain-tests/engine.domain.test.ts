import { vi } from 'vite-plus/test'

vi.mock('../database', () => ({ read: () => [] }))
