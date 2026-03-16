/**
 * wyLoader — route loader helper for TanStack Start SSR.
 * Pre-fetches WyStack query data server-side so the client hydrates instantly.
 *
 * Usage in a route file:
 * ```
 * export const Route = createFileRoute('/app/people')({
 *   loader: wyLoader('listPeople'),
 *   component: PeoplePage,
 * })
 * ```
 */

interface LoaderContext {
  queryClient: {
    ensureQueryData: (opts: { queryKey: any[]; queryFn: () => Promise<any> }) => Promise<any>
  }
  [key: string]: any
}

export function wyLoader(path: string, args?: any) {
  const queryKey = args !== undefined
    ? ['wystack', path, args]
    : ['wystack', path]

  return async (ctx: { context: LoaderContext }) => {
    const serverUrl = process.env.WYSTACK_URL ?? 'http://localhost:3001'
    const argsParam = args ? `?args=${encodeURIComponent(JSON.stringify(args))}` : ''

    return ctx.context.queryClient.ensureQueryData({
      queryKey,
      queryFn: async () => {
        const res = await fetch(`${serverUrl}/wystack/${path}${argsParam}`)
        const json = await res.json()
        if (json.error) throw new Error(json.error)
        return json.data
      },
    })
  }
}
