import { vi } from 'vite-plus/test'

function useLocalMock(vi: { mock: (name: string) => void }) {
  vi.mock('../local-double')
}

void useLocalMock
