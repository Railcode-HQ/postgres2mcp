import { useEffect, useState } from 'react'

const isDark = () => document.documentElement.classList.contains('dark')

/** Whether the app is in dark mode right now — watches the class on <html>. */
export function useDarkMode(): boolean {
  const [dark, setDark] = useState(isDark)

  useEffect(() => {
    const observer = new MutationObserver(() => setDark(isDark()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
    return () => observer.disconnect()
  }, [])

  return dark
}
