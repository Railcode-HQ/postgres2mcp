// Light/dark. The `.dark` class on <html> is the single source of truth; the
// inline script in index.html resolves it before first paint, this module
// changes it afterwards.

export const THEME_KEY = 'p2m-theme'

export function setTheme(mode: 'light' | 'dark'): void {
  document.documentElement.classList.toggle('dark', mode === 'dark')
  try {
    localStorage.setItem(THEME_KEY, mode)
  } catch {
    /* the choice just won't persist */
  }
}

/** Until the toggle is pressed, follow the operating system as it changes. */
export function followSystemTheme(): () => void {
  const media = window.matchMedia('(prefers-color-scheme: dark)')
  const onChange = () => {
    let stored: string | null = null
    try {
      stored = localStorage.getItem(THEME_KEY)
    } catch {
      /* fall through to the system preference */
    }
    if (stored !== 'light' && stored !== 'dark') {
      document.documentElement.classList.toggle('dark', media.matches)
    }
  }
  media.addEventListener('change', onChange)
  return () => media.removeEventListener('change', onChange)
}
