import { create } from 'zustand'
import type { ApiKey } from '@/lib/types'

const STORAGE_KEY = 'p2m-onboarding'

/** Where the first-run guide stands in this browser. */
interface Progress {
  /** When the guide was first shown (ISO). A key used after this is "the client connecting". */
  startedAt: string
  /** The newest call in the log at that moment. A call after it is "the first call". */
  afterLog: number
}

type Saved = { state: 'started'; progress: Progress } | { state: 'done' }

function read(): Saved | null {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Saved | null
    if (saved?.state === 'done') return saved
    if (saved?.state === 'started' && typeof saved.progress?.startedAt === 'string') return saved
    return null
  } catch {
    return null
  }
}

function write(saved: Saved | null): void {
  try {
    if (saved === null) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    /* storage unavailable — the guide just starts over after a reload */
  }
}

interface OnboardingState {
  /** The guide was finished or skipped in this browser. */
  done: boolean
  /** Set once the guide has been shown, so a reload mid-way comes back to it. */
  progress: Progress | null
  /** The guide was asked for again from the dashboard. */
  reopened: boolean
  /**
   * The key the guide created, with its token. Kept in memory only: a token is
   * shown once, so it survives moving around the dashboard but not a reload.
   */
  created: { key: ApiKey; token: string } | null
  begin: (afterLog: number) => void
  setCreated: (created: { key: ApiKey; token: string } | null) => void
  finish: () => void
  /** Open the guide again, to connect another client. */
  reopen: () => void
}

const saved = read()

export const useOnboardingStore = create<OnboardingState>((set) => ({
  done: saved?.state === 'done',
  progress: saved?.state === 'started' ? saved.progress : null,
  reopened: false,
  created: null,

  begin: (afterLog) => {
    const progress = { startedAt: new Date().toISOString(), afterLog }
    write({ state: 'started', progress })
    set({ progress })
  },

  setCreated: (created) => set({ created }),

  finish: () => {
    write({ state: 'done' })
    set({ done: true, progress: null, reopened: false, created: null })
  },

  reopen: () => {
    write(null)
    set({ done: false, progress: null, reopened: true, created: null })
  },
}))
