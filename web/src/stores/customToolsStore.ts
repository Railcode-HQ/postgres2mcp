import { create } from 'zustand'
import { api, ApiError } from '@/lib/api'
import type { CustomTool, QueryResult, ToolParam } from '@/lib/types'

interface ToolInput {
  sql: string
  params: ToolParam[]
  description: string
  allow_writes: boolean
  /** Custom groups the tool should be in. */
  groups: string[]
}

export type RunOutcome = { result: QueryResult } | { error: ApiError | Error }

interface CustomToolsState {
  tools: CustomTool[]
  loaded: boolean
  error: string | null
  fetchTools: () => Promise<void>
  fetchTool: (name: string) => Promise<CustomTool | null>
  createTool: (input: ToolInput & { name: string }) => Promise<CustomTool | { error: string }>
  updateTool: (name: string, input: ToolInput) => Promise<CustomTool | { error: string }>
  deleteTool: (name: string) => Promise<string | null>
  /** Run an unsaved draft: validated, compiled and executed exactly like a real call. */
  testDraft: (input: {
    name?: string
    sql: string
    params: ToolParam[]
    values: Record<string, unknown>
    allow_writes: boolean
  }) => Promise<RunOutcome>
  /** Run arbitrary SQL from the console. */
  runSql: (input: { sql: string; allow_writes: boolean }) => Promise<RunOutcome>
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : 'Something went wrong')
const asError = (error: unknown) => (error instanceof Error ? error : new Error('Something went wrong'))
const path = (name: string) => `/custom-tools/${encodeURIComponent(name)}`

export const useCustomToolsStore = create<CustomToolsState>((set, get) => ({
  tools: [],
  loaded: false,
  error: null,

  fetchTools: async () => {
    try {
      set({ tools: await api.get<CustomTool[]>('/custom-tools'), loaded: true, error: null })
    } catch (error) {
      set({ loaded: true, error: message(error) })
    }
  },

  fetchTool: async (name) => {
    try {
      return await api.get<CustomTool>(path(name))
    } catch {
      return null
    }
  },

  createTool: async (input) => {
    try {
      const created = await api.post<CustomTool>('/custom-tools', input)
      void get().fetchTools()
      return created
    } catch (error) {
      return { error: message(error) }
    }
  },

  updateTool: async (name, input) => {
    try {
      const updated = await api.patch<CustomTool>(path(name), input)
      void get().fetchTools()
      return updated
    } catch (error) {
      return { error: message(error) }
    }
  },

  deleteTool: async (name) => {
    try {
      await api.delete(path(name))
      await get().fetchTools()
      return null
    } catch (error) {
      return message(error)
    }
  },

  testDraft: async (input) => {
    try {
      return { result: await api.post<QueryResult>('/custom-tool-drafts/test', input) }
    } catch (error) {
      return { error: asError(error) }
    }
  },

  runSql: async (input) => {
    try {
      return { result: await api.post<QueryResult>('/sql', input) }
    } catch (error) {
      return { error: asError(error) }
    }
  },
}))
