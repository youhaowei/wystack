interface PageMark {
  name: string
  start: number
  marks: Record<string, number>
}

const isDev = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV

const globals = globalThis as Record<string, unknown>
// __wystack_page_marks__ is a reserved globalThis key — do not use elsewhere
const active = (globals.__wystack_page_marks__ ??= new Map()) as Map<string, PageMark>

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
  const {
    page: _reserved1,
    total_ms: _reserved2,
    ...safeMarks
  } = page.marks as Record<string, number>
  const entry = { page: page.name, total_ms: total, ...safeMarks }

  if (isDev) {
    if (total > 1000) {
      console.warn('[wystack/log]', entry)
    } else {
      console.debug('[wystack/log]', entry)
    }
  }

  return entry
}
