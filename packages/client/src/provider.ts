import { createElement, useMemo } from 'react'
import type { WyStackClient } from './client.js'
import { isWebClient, toWebClient } from './client.js'
import {
  WyStackProvider as ReactWyStackProvider,
  useWyStackClient as useReactWyStackClient,
} from './react-provider.js'

/** Backward-compatible web provider exported from `@wystack/client`. */
export function WyStackProvider(props: { client: WyStackClient; children: React.ReactNode }) {
  const client = useMemo(() => toWebClient(props.client), [props.client])

  return createElement(ReactWyStackProvider, { client, children: props.children })
}

export function useWyStackClient(): WyStackClient {
  const client = useReactWyStackClient()
  if (!isWebClient(client)) {
    throw new Error('The @wystack/client root hook requires a web client')
  }
  return client
}
