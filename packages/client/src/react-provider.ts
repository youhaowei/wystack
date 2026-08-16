import { createContext, createElement, useContext, useEffect } from 'react'
import type { Client } from './core-client.js'

const WyStackContext = createContext<Client | null>(null)
const mountedProviders = new WeakMap<Client, number>()

/** Transport-neutral provider shared by every React renderer. */
export function WyStackProvider(props: { client: Client; children: React.ReactNode }) {
  useEffect(() => {
    const mounts = mountedProviders.get(props.client) ?? 0
    if (mounts === 0) props.client.connect()
    mountedProviders.set(props.client, mounts + 1)

    return () => {
      const remaining = (mountedProviders.get(props.client) ?? 1) - 1
      if (remaining > 0) {
        mountedProviders.set(props.client, remaining)
        return
      }

      mountedProviders.delete(props.client)
      props.client.disconnect()
    }
  }, [props.client])

  return createElement(WyStackContext.Provider, { value: props.client }, props.children)
}

export function useWyStackClient(): Client {
  const client = useContext(WyStackContext)
  if (!client) throw new Error('useWyStackClient must be used within <WyStackProvider>')
  return client
}
