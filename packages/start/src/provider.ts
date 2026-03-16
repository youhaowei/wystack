import { createContext, useContext, createElement, useEffect } from 'react'
import type { WyStartClient } from './client'

const WyStartContext = createContext<WyStartClient | null>(null)

export function WyStackProvider(props: { client: WyStartClient; children: React.ReactNode }) {
  // Connect WS on mount, disconnect on unmount
  useEffect(() => {
    props.client.connect()
    return () => props.client.disconnect()
  }, [props.client])

  return createElement(WyStartContext.Provider, { value: props.client }, props.children)
}

export function useWyStartClient(): WyStartClient {
  const client = useContext(WyStartContext)
  if (!client) throw new Error('useWyStartClient must be used within <WyStackProvider>')
  return client
}
