import { create } from 'zustand'
import { api, ApiError, qs } from '@/lib/api'
import type { LogEntry, LogSource, LogStatus, Stats, StatsRange } from '@/lib/types'

export interface LogFilters {
  status: LogStatus | null
  source: LogSource | null
  tool: string | null
  key_id: string | null
  q: string
}

const NO_FILTERS: LogFilters = { status: null, source: null, tool: null, key_id: null, q: '' }
const PAGE = 100

interface LogPage {
  logs: LogEntry[]
  next_before: number | null
}

interface LogsState {
  logs: LogEntry[]
  nextBefore: number | null
  filters: LogFilters
  loading: boolean
  loadingMore: boolean
  error: string | null
  fetchLogs: (options?: { quiet?: boolean }) => Promise<void>
  loadMore: () => Promise<void>
  setFilter: <K extends keyof LogFilters>(key: K, value: LogFilters[K]) => void
  clearFilters: () => void
  clearLogs: () => Promise<number | null>

  stats: Stats | null
  statsRange: StatsRange
  statsLoading: boolean
  statsError: string | null
  setStatsRange: (range: StatsRange) => void
  fetchStats: (options?: { quiet?: boolean }) => Promise<void>
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : 'Something went wrong')

const queryFor = (filters: LogFilters, extra: Record<string, number | null>) =>
  qs({ ...filters, q: filters.q.trim(), ...extra })

export const useLogsStore = create<LogsState>((set, get) => ({
  logs: [],
  nextBefore: null,
  filters: NO_FILTERS,
  loading: false,
  loadingMore: false,
  error: null,

  fetchLogs: async ({ quiet = false } = {}) => {
    const { filters } = get()
    if (!quiet) set({ loading: true })
    try {
      const page = await api.get<LogPage>(`/logs${queryFor(filters, { limit: PAGE })}`)
      // A slow response for filters that have since changed must not overwrite the tape.
      if (get().filters !== filters) return
      set({ logs: page.logs, nextBefore: page.next_before, loading: false, error: null })
    } catch (error) {
      set({ loading: false, error: message(error) })
    }
  },

  loadMore: async () => {
    const { filters, nextBefore, logs } = get()
    if (nextBefore === null) return
    set({ loadingMore: true })
    try {
      const page = await api.get<LogPage>(`/logs${queryFor(filters, { limit: PAGE, before: nextBefore })}`)
      if (get().filters !== filters) return
      set({ logs: [...logs, ...page.logs], nextBefore: page.next_before, loadingMore: false })
    } catch (error) {
      set({ loadingMore: false, error: message(error) })
    }
  },

  setFilter: (key, value) => {
    set((state) => ({ filters: { ...state.filters, [key]: value } }))
    void get().fetchLogs()
  },

  clearFilters: () => {
    set({ filters: { ...NO_FILTERS } })
    void get().fetchLogs()
  },

  clearLogs: async () => {
    try {
      const { deleted } = await api.delete<{ deleted: number }>('/logs')
      await get().fetchLogs()
      void get().fetchStats({ quiet: true })
      return deleted
    } catch (error) {
      set({ error: message(error) })
      return null
    }
  },

  stats: null,
  statsRange: '24h',
  statsLoading: false,
  statsError: null,

  setStatsRange: (range) => {
    set({ statsRange: range })
    void get().fetchStats()
  },

  fetchStats: async ({ quiet = false } = {}) => {
    const range = get().statsRange
    if (!quiet) set({ statsLoading: true })
    try {
      const stats = await api.get<Stats>(`/stats${qs({ range })}`)
      if (get().statsRange !== range) return
      set({ stats, statsLoading: false, statsError: null })
    } catch (error) {
      set({ statsLoading: false, statsError: message(error) })
    }
  },
}))
