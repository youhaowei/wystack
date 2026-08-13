import { createContext, createElement, useContext, useEffect } from 'react'
import type { Client } from './core-client'

const WyStackContext = createContext<Client | null>(null)

/** Transport-neutral provider shared by every React renderer. */
export function WyStackProvider(props: { client: Client; children: React.ReactNode }) {
  useEffect(() => {
    props.client.connect()
    return () => props.client.disconnect()
  }, [props.client])

  return createElement(WyStackContext.Provider, { value: props.client }, props.children)
}

export function useWyStackClient(): Client {
  const client = useContext(WyStackContext)
  if (!client) throw new Error('useWyStackClient must be used within <WyStackProvider>')
  return client
}
