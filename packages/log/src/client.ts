interface PageMark {
  name: string
  start: number
  marks: Record<string, number>
}

const active = new Map<string, PageMark>()

export function startPageMark(name: string) {
  active.set(name, { name, start: performance.now(), marks: {} })
}

export function mark(pageName: string, markName: string) {
  const page = active.get(pageName)
  if (!page) return
  page.marks[markName] = Math.round(performance.now() - page.start)
}

export function flushPageMark(pageName: string) {
  const page = active.get(pageName)
  if (!page) return
  active.delete(pageName)

  const total = Math.round(performance.now() - page.start)
  const entry = { page: page.name, total_ms: total, ...page.marks }

  const isDev =
    typeof import.meta !== 'undefined' &&
    import.meta.env &&
    (import.meta.env.DEV || import.meta.env.NODE_ENV !== 'production')

  if (isDev) {
    if (total > 1000) {
      console.warn('[wystack/log]', entry)
    } else {
      console.debug('[wystack/log]', entry)
    }
  }

  return entry
}
