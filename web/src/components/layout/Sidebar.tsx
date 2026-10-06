import { useState } from 'react'
import { LogOut, Menu, X } from 'lucide-react'
import { useAuthStore } from '@/stores/authStore'
import { useStatusStore } from '@/stores/statusStore'
import { BrandMark } from '@/components/BrandMark'
import { Button } from '@/components/ui/button'
import { NavItem, type NavItemDef } from '@/components/layout/NavItem'
import { cn } from '@/lib/utils'

export type { NavItemDef }

export function Sidebar({
  items,
  active,
  onNavigate,
}: {
  items: NavItemDef[]
  active: string
  onNavigate: (key: string) => void
}) {
  const logout = useAuthStore((s) => s.logout)
  const username = useAuthStore((s) => s.username)
  const status = useStatusStore((s) => s.status)
  const database = status?.database
  // Below md the sidebar is a bar: the brand, the database, and a menu that
  // opens the rest. From md up everything is always on show.
  const [menu, setMenu] = useState(false)
  const dot = (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        database === undefined ? 'bg-muted-foreground/40' : database.connected ? 'bg-emerald-500' : 'bg-red-500'
      )}
    />
  )

  return (
    <aside className="flex flex-col px-3 py-2 md:h-screen md:overflow-y-auto md:py-3.5">
      <div className="flex h-9 items-center gap-2 px-2 font-semibold tracking-tight">
        <BrandMark className="size-5 shrink-0" />
        <span>postgres2mcp</span>
        <span className="ml-auto flex min-w-0 items-center gap-2 md:hidden">
          {dot}
          <span className="truncate font-mono text-xs font-medium text-muted-foreground">
            {database?.name ?? (database?.connected === false ? 'not connected' : '')}
          </span>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            className="-mr-2 shrink-0"
            aria-expanded={menu}
            aria-controls="p2m-menu"
            aria-label={menu ? 'Close menu' : 'Menu'}
            onClick={() => setMenu(!menu)}
          >
            {menu ? <X /> : <Menu />}
          </Button>
        </span>
      </div>

      <div id="p2m-menu" className={cn('flex-1 flex-col pb-2 md:flex md:pb-0', menu ? 'flex' : 'hidden')}>
        <nav aria-label="Sections" className="mt-2 flex flex-col gap-0.5 border-t border-border pt-3 md:mt-3 md:pt-4">
          {items.map((item) => (
            <NavItem
              key={item.key}
              active={active === item.key}
              icon={item.icon}
              count={item.count}
              onSelect={() => onNavigate(item.key)}
            >
              {item.label}
            </NavItem>
          ))}
        </nav>

        <div className="mt-auto space-y-1 pt-6">
          {/* The database this server exposes — always in view, so it is never a
              question which one a query is about to run against. */}
          <div
            className="flex items-center gap-2.5 rounded-lg px-1 py-1.5"
            title={database?.connected === false ? (database.error ?? 'Not connected') : 'Connected'}
          >
            <span className="grid size-8 shrink-0 place-items-center">{dot}</span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate font-mono text-[0.8125rem] font-medium">
                {database?.name ?? (database?.connected === false ? 'not connected' : '…')}
              </span>
              <span className="block truncate text-[0.6875rem] text-muted-foreground">
                {database?.connected
                  ? `${database.user}@${database.host ?? 'local'}`
                  : database
                    ? 'database unreachable'
                    : 'connecting'}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2.5 border-t border-border px-1 pt-2">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-blue-500/10 text-[0.75rem] font-semibold text-blue-600 dark:text-blue-400">
              {(username ?? '—').charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[0.8125rem] font-medium">{username ?? '…'}</span>
              <span className="block truncate text-[0.6875rem] text-muted-foreground">Administrator</span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              type="button"
              title="Sign out"
              aria-label="Sign out"
              onClick={() => void logout()}
            >
              <LogOut />
            </Button>
          </div>
        </div>
      </div>
    </aside>
  )
}
