import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface NavItemDef {
  key: string
  label: string
  icon: LucideIcon
  /** A count shown at the end of the row (API keys). */
  count?: number
}

// A nav row: icon, label, optional count. `active` is the page you are on —
// a raised pill on the sidebar surface.
export function NavItem({
  active,
  icon: Icon,
  count,
  onSelect,
  children,
}: {
  active: boolean
  icon: LucideIcon
  count?: number
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[0.8125rem] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 md:h-8',
        active
          ? 'bg-background text-foreground shadow-[0_1px_2px_rgba(20,30,60,0.06)] ring-1 ring-border'
          : 'text-secondary-foreground hover:bg-foreground/[0.04] hover:text-foreground'
      )}
    >
      <Icon
        className={cn('size-4 shrink-0', active ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground')}
      />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {count !== undefined && count > 0 ? (
        <span className="tabular font-mono text-[0.6875rem] text-muted-foreground">{count}</span>
      ) : null}
    </button>
  )
}
