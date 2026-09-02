export async function loadPglite() {
  await import('@electric-sql/pglite')
  await import('@electric-sql/pglite/worker')
}
