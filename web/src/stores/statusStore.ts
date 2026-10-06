import { create } from 'zustand'
import { api } from '@/lib/api'
import type { Status } from '@/lib/types'

interface StatusState {
  status: Status | null
  fetchStatus: () => Promise<void>
}

export const useStatusStore = create<StatusState>((set) => ({
  status: null,
  fetchStatus: async () => {
    try {
      set({ status: await api.get<Status>('/status') })
    } catch {
      /* the shell keeps its last known status; pages surface their own errors */
    }
  },
}))
