import { create } from 'zustand'
import { api, ApiError } from '@/lib/api'
import type { ResultFormat, Settings } from '@/lib/types'

interface SettingsState {
  settings: Settings | null
  error: string | null
  fetchSettings: () => Promise<void>
  setResultFormat: (format: ResultFormat) => Promise<string | null>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: null,
  error: null,

  fetchSettings: async () => {
    try {
      set({ settings: await api.get<Settings>('/settings'), error: null })
    } catch (error) {
      set({ error: error instanceof ApiError ? error.message : 'Could not load settings' })
    }
  },

  setResultFormat: async (format) => {
    try {
      set({ settings: await api.patch<Settings>('/settings', { result_format: format }), error: null })
      return null
    } catch (error) {
      return error instanceof ApiError ? error.message : 'Could not save the setting'
    }
  },
}))
