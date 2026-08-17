import { vi } from 'vite-plus/test'

vi.mock('../browser-api', () => ({ read: () => [] }))
