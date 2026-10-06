import { create } from 'zustand'
import { api, ApiError } from '@/lib/api'
import type { Catalog, SchemaTable, ToolGroup, ToolInfo } from '@/lib/types'

interface GroupInput {
  name?: string
  description?: string
  tools: string[]
}

interface CatalogState {
  tools: ToolInfo[]
  groups: ToolGroup[]
  loaded: boolean
  error: string | null
  /** Tables and columns of the target database, for the editor. */
  schema: SchemaTable[]
  schemaLoaded: boolean
  schemaError: string | null
  fetchCatalog: () => Promise<void>
  fetchSchema: () => Promise<void>
  createGroup: (id: string, input: GroupInput) => Promise<string | null>
  updateGroup: (id: string, input: Partial<GroupInput>) => Promise<string | null>
  deleteGroup: (id: string) => Promise<string | null>
}

const message = (error: unknown) => (error instanceof ApiError ? error.message : 'Something went wrong')

export const useCatalogStore = create<CatalogState>((set, get) => ({
  tools: [],
  groups: [],
  loaded: false,
  error: null,
  schema: [],
  schemaLoaded: false,
  schemaError: null,

  fetchCatalog: async () => {
    try {
      const catalog = await api.get<Catalog>('/tools')
      set({ tools: catalog.tools, groups: catalog.groups, loaded: true, error: null })
    } catch (error) {
      set({ loaded: true, error: message(error) })
    }
  },

  fetchSchema: async () => {
    try {
      const { tables } = await api.get<{ tables: SchemaTable[] }>('/schema')
      set({ schema: tables, schemaLoaded: true, schemaError: null })
    } catch (error) {
      set({ schemaLoaded: true, schemaError: message(error) })
    }
  },

  createGroup: async (id, input) => {
    try {
      await api.post('/groups', { id, ...input })
      await get().fetchCatalog()
      return null
    } catch (error) {
      return message(error)
    }
  },

  updateGroup: async (id, input) => {
    try {
      await api.patch(`/groups/${encodeURIComponent(id)}`, input)
      await get().fetchCatalog()
      return null
    } catch (error) {
      return message(error)
    }
  },

  deleteGroup: async (id) => {
    try {
      await api.delete(`/groups/${encodeURIComponent(id)}`)
      await get().fetchCatalog()
      return null
    } catch (error) {
      return message(error)
    }
  },
}))
