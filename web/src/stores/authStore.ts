import { create } from 'zustand'
import { api, ApiError, readToken, setUnauthorizedHandler, writeToken } from '@/lib/api'

interface SignedIn {
  token: string
  user: { username: string }
}

/**
 * The setup code from a `/?setup=…` link, taken out of the address bar at once
 * so it does not linger in the history or get copied along with the URL.
 */
function takeSetupCode(): string | null {
  try {
    const url = new URL(window.location.href)
    const code = url.searchParams.get('setup')
    if (code === null) return null
    url.searchParams.delete('setup')
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash)
    return code === '' ? null : code
  } catch {
    return null
  }
}

interface AuthState {
  /** null until the server has been asked. */
  setupRequired: boolean | null
  /** First-run setup needs the code the server was started with. */
  setupCodeRequired: boolean
  /** The code this page was opened with, if the link carried one. */
  setupCode: string | null
  token: string | null
  username: string | null
  /** The server could not be reached at boot. */
  unreachable: boolean
  /** Ask the server whether it needs first-run setup, and who the saved session belongs to. */
  init: () => Promise<void>
  /** Create the first admin account. Resolves to what went wrong, or null. */
  setup: (
    username: string,
    password: string,
    setupCode?: string
  ) => Promise<{ message: string; codeRefused: boolean } | null>
  login: (username: string, password: string) => Promise<string | null>
  logout: () => Promise<void>
  changePassword: (current: string, next: string) => Promise<string | null>
}

const message = (error: unknown, fallback: string) => (error instanceof ApiError ? error.message : fallback)

export const useAuthStore = create<AuthState>((set, get) => {
  const signIn = ({ token, user }: SignedIn) => {
    writeToken(token)
    set({ token, username: user.username, setupRequired: false })
  }

  return {
    setupRequired: null,
    setupCodeRequired: false,
    setupCode: takeSetupCode(),
    token: readToken(),
    username: null,
    unreachable: false,

    init: async () => {
      try {
        const state = await api.anonymous<{ setup_required: boolean; setup_code_required?: boolean }>(
          'GET',
          '/auth/state'
        )
        set({
          setupRequired: state.setup_required,
          setupCodeRequired: state.setup_code_required === true,
          unreachable: false,
        })
      } catch {
        set({ unreachable: true })
        return
      }
      if (get().token === null) return
      try {
        const me = await api.get<{ username: string }>('/auth/me')
        set({ username: me.username })
      } catch {
        /* a dead session was already cleared by the 401 handler */
      }
    },

    setup: async (username, password, setupCode) => {
      try {
        signIn(
          await api.anonymous<SignedIn>('POST', '/auth/setup', {
            username,
            password,
            ...(setupCode ? { setup_code: setupCode } : {}),
          })
        )
        set({ setupCode: null })
        return null
      } catch (error) {
        return {
          message: message(error, 'Could not create the account.'),
          codeRefused: error instanceof ApiError && error.tag === 'Forbidden',
        }
      }
    },

    login: async (username, password) => {
      try {
        signIn(await api.anonymous<SignedIn>('POST', '/auth/login', { username, password }))
        return null
      } catch (error) {
        return message(error, 'Could not sign in.')
      }
    },

    logout: async () => {
      try {
        await api.post('/auth/logout')
      } catch {
        /* the session is forgotten locally either way */
      }
      writeToken(null)
      set({ token: null, username: null })
    },

    changePassword: async (current, next) => {
      try {
        await api.post('/auth/password', { current_password: current, new_password: next })
        return null
      } catch (error) {
        return message(error, 'Could not change the password.')
      }
    },
  }
})

// A 401 on any request means the session ended (expired, signed out elsewhere,
// password reset): drop it and let the sign-in screen take over.
setUnauthorizedHandler(() => {
  writeToken(null)
  useAuthStore.setState({ token: null, username: null })
})
