export function buildAuthRequest(upgradeRequest: Request, token: string | null): Request {
  const headers = new Headers(upgradeRequest.headers)
  if (token !== null && token.length > 0) {
    headers.set('authorization', `Bearer ${token}`)
  } else {
    headers.delete('authorization')
  }
  return new Request(upgradeRequest.url, {
    method: upgradeRequest.method,
    headers,
  })
}
