import { createContext, createElement, useContext, useEffect } from 'react'
import type { Client } from './core-client.js'

const WyStackContext = createContext<Client | null>(null)
type ClientLifecycle = { mounts: number; disconnectVersion: number }
const clientLifecycles = new WeakMap<Client, ClientLifecycle>()

/** Transport-neutral provider shared by every React renderer. */
export function WyStackProvider(props: { client: Client; children: React.ReactNode }) {
  useEffect(() => {
    let lifecycle = clientLifecycles.get(props.client)
    if (!lifecycle) {
      props.client.connect()
      lifecycle = { mounts: 0, disconnectVersion: 0 }
      clientLifecycles.set(props.client, lifecycle)
    }

    lifecycle.mounts += 1
    lifecycle.disconnectVersion += 1

    return () => {
      lifecycle.mounts -= 1
      if (lifecycle.mounts > 0) return

      const disconnectVersion = ++lifecycle.disconnectVersion
      void Promise.resolve().then(() => {
        if (lifecycle.mounts > 0 || lifecycle.disconnectVersion !== disconnectVersion) return

        clientLifecycles.delete(props.client)
        props.client.disconnect()
      })
    }
  }, [props.client])

  return createElement(WyStackContext.Provider, { value: props.client }, props.children)
}

export function useWyStackClient(): Client {
  const client = useContext(WyStackContext)
  if (!client) throw new Error('useWyStackClient must be used within <WyStackProvider>')
  return client
}
