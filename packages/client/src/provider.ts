import { createContext, useContext, createElement, useEffect } from 'react'
import type { WyStackClient } from './client'

const WyStackContext = createContext<WyStackClient | null>(null)

export function WyStackProvider(props: { client: WyStackClient; children: React.ReactNode }) {
  // Connect WS on mount, disconnect on unmount
  useEffect(() => {
    props.client.ws.connect()
    return () => props.client.ws.disconnect()
  }, [props.client])

  return createElement(WyStackContext.Provider, { value: props.client }, props.children)
}

export function useWyStackClient(): WyStackClient {
  const client = useContext(WyStackContext)
  if (!client) throw new Error('useWyStackClient must be used within <WyStackProvider>')
  return client
}
