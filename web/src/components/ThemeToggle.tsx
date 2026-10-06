import { Moon, Sun } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { setTheme } from '@/lib/theme'
import { useDarkMode } from '@/lib/useDarkMode'

// Flips the mode and remembers the choice. Until it is pressed the app follows
// the operating system.
export function ThemeToggle({ className }: { className?: string }) {
  const dark = useDarkMode()
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      title={dark ? 'Light mode' : 'Dark mode'}
      className={className}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  )
}
