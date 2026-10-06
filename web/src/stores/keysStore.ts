import { create } from 'zustand'
import { api, ApiError } from '@/lib/api'
import type { ApiKey, ResultFormat } from '@/lib/types'

interface KeyInput {
  name: string
  groups: string[]
  tools: string[]
  /** null follows the server default. */
  result_format: ResultFormat | null
}

interface KeysState {
  keys: ApiKey[]
  loaded: boolean
  error: string | null
  fetchKeys: () => Promise<void>
  /** Resolves to the one-time token, or an error message. */
  createKey: (input: KeyInput) => Promise<{ key: ApiKey; token: string } | { error: string }>
  updateKey: (id: string, input: Partial<KeyInput> & { enabled?: boolean }) => Promise<string | null>
  deleteKey: (id: string) => Promise<string | null>
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : 'Something went wrong')

export const useKeysStore = create<KeysState>((set, get) => ({
  keys: [],
  loaded: false,
  error: null,

  fetchKeys: async () => {
    try {
      set({ keys: await api.get<ApiKey[]>('/keys'), loaded: true, error: null })
    } catch (error) {
      set({ loaded: true, error: message(error) })
    }
  },

  createKey: async (input) => {
    try {
      const created = await api.post<{ key: ApiKey; token: string }>('/keys', input)
      await get().fetchKeys()
      return created
    } catch (error) {
      return { error: message(error) }
    }
  },

  updateKey: async (id, input) => {
    try {
      await api.patch(`/keys/${encodeURIComponent(id)}`, input)
      await get().fetchKeys()
      return null
    } catch (error) {
      return message(error)
    }
  },

  deleteKey: async (id) => {
    try {
      await api.delete(`/keys/${encodeURIComponent(id)}`)
      await get().fetchKeys()
      return null
    } catch (error) {
      return message(error)
    }
  },
}))
