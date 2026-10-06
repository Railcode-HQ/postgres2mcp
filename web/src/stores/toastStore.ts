import { create } from 'zustand'

/* Transient, bottom-of-screen notices with an optional single action. Built here
 * rather than pulled in as a dependency — the app needs one primitive (an
 * undoable confirmation), not a notification framework.
 *
 * The default lifetime is deliberately LONG. A toast that only reports something
 * can flash by in 3s; a toast whose whole point is an Undo has to be read,
 * understood, and acted on, so 8s is the floor for that to be a real offer rather
 * than a tease. `<Toaster />` also pauses the countdown on hover/focus. */
export const DEFAULT_TOAST_MS = 8000

export interface ToastAction {
  label: string
  onClick: () => void
}

export interface Toast {
  id: string
  message: string
  /** `error` for something that did not happen; the default is a plain notice. */
  tone?: 'error'
  action?: ToastAction
  durationMs: number
}

type ToastInput = { message: string; tone?: 'error'; action?: ToastAction; durationMs?: number }

let nextId = 0

interface ToastState {
  toasts: Toast[]
  push: (toast: ToastInput) => string
  dismiss: (id: string) => void
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],

  push: ({ message, tone, action, durationMs = DEFAULT_TOAST_MS }) => {
    nextId += 1
    const id = `toast-${nextId}`
    set((s) => ({ toasts: [...s.toasts, { id, message, tone, action, durationMs }] }))
    return id
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

// Convenience for call sites that don't need the hook (event handlers, stores).
export function toast(input: ToastInput): string {
  return useToastStore.getState().push(input)
}

/**
 * Report how an action ended: `failure` is the error message, or null when it
 * worked, in which case `done` is what to say.
 */
export function toastOutcome(failure: string | null, done: string): string {
  return toast(failure === null ? { message: done } : { message: failure, tone: 'error' })
}
