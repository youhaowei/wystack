import { useState, useEffect, useRef, useCallback } from 'react'
import type { UseQueryResult, UseMutationResult } from './types'
import { useWyStackClient } from './provider'

let subIdCounter = 0
function nextSubId() {
  return `sub_${++subIdCounter}`
}

/**
 * useWyQuery — subscribe to a reactive query via WebSocket.
 * Returns { data, isLoading, error } that auto-updates when data changes.
 */
export function useWyQuery<TReturn = unknown>(
  path: string,
  args: unknown = {},
): UseQueryResult<TReturn> {
  const client = useWyStackClient()
  const [data, setData] = useState<TReturn | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const subIdRef = useRef<string | null>(null)

  useEffect(() => {
    const subId = nextSubId()
    subIdRef.current = subId

    client.ws.subscribe(subId, path, args, (raw) => {
      const msg = raw as Record<string, unknown>
      if (msg.type === 'data') {
        setData(msg.data as TReturn)
        setIsLoading(false)
        setError(null)
      } else if (msg.type === 'error') {
        setError(new Error(msg.error as string))
        setIsLoading(false)
      }
    })

    return () => {
      client.ws.unsubscribe(subId)
    }
  }, [path, JSON.stringify(args)])

  return { data, isLoading, error }
}

/**
 * useWyMutation — HTTP POST mutation.
 * Returns { mutate, isLoading, error }.
 */
export function useWyMutation<TArgs = unknown, TReturn = unknown>(
  path: string,
): UseMutationResult<TArgs, TReturn> {
  const client = useWyStackClient()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)

  const mutate = useCallback(async (args: TArgs): Promise<TReturn> => {
    setIsLoading(true)
    setError(null)
    try {
      const result = await client.call(path, args)
      return result as TReturn
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      setError(error)
      throw error
    } finally {
      setIsLoading(false)
    }
  }, [path])

  return { mutate, isLoading, error }
}
