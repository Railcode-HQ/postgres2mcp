// The single HTTP entry point. Every request carries the session token; a 401
// means the session is no longer good, so it ends and the sign-in screen takes
// over.

const TOKEN_KEY = 'p2m-session'

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function writeToken(token: string | null): void {
  try {
    if (token === null) localStorage.removeItem(TOKEN_KEY)
    else localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* storage unavailable — the session just won't survive a reload */
  }
}

/** A failed request, carrying what the server said. */
export class ApiError extends Error {
  readonly status: number
  readonly tag: string | null
  readonly detail: string | null
  readonly hint: string | null
  readonly position: number | null

  constructor(status: number, body: unknown) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
    super(
      typeof record.message === 'string' && record.message !== ''
        ? record.message
        : status === 0
          ? 'Cannot reach the server'
          : `Request failed (${status})`
    )
    this.status = status
    this.tag = typeof record._tag === 'string' ? record._tag : null
    this.detail = typeof record.detail === 'string' ? record.detail : null
    this.hint = typeof record.hint === 'string' ? record.hint : null
    this.position = typeof record.position === 'number' ? record.position : null
  }
}

let onUnauthorized: (() => void) | null = null

/** The auth store registers here so a 401 anywhere signs the session out. */
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler
}

async function request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
  const bearer = token ?? readToken()
  let response: Response
  try {
    response = await fetch(`/api${path}`, {
      method,
      headers: {
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError(0, null)
  }
  const text = await response.text()
  let parsed: unknown = null
  if (text !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { message: text.slice(0, 300) }
    }
  }
  if (!response.ok) {
    // Only an ambient-session 401 ends the session; a sign-in attempt reports its own failure.
    if (response.status === 401 && token === undefined) onUnauthorized?.()
    throw new ApiError(response.status, parsed)
  }
  return parsed as T
}

export const api = {
  get: <T>(path: string, token?: string) => request<T>('GET', path, undefined, token),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  /** A request made without the ambient session — signing in, first-run setup. */
  anonymous: <T>(method: 'GET' | 'POST', path: string, body?: unknown) => request<T>(method, path, body, ''),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, body),
  delete: <T = null>(path: string) => request<T>('DELETE', path),
}

/** Build a query string, skipping empty values. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== '') search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}
