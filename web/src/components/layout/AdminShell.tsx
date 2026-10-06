import { useEffect, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Activity, KeyRound, Layers, ScrollText, Settings, SquareTerminal, Wrench } from 'lucide-react'
import { Sidebar, type NavItemDef } from '@/components/layout/Sidebar'
import { ThemeToggle } from '@/components/ThemeToggle'
import { useKeysStore } from '@/stores/keysStore'
import { useStatusStore } from '@/stores/statusStore'

const SECTIONS = [
  { key: 'overview', label: 'Overview', icon: Activity, path: '/' },
  { key: 'tools', label: 'Tools', icon: Wrench, path: '/tools' },
  { key: 'groups', label: 'Tool groups', icon: Layers, path: '/groups' },
  { key: 'sql', label: 'SQL console', icon: SquareTerminal, path: '/sql' },
  { key: 'keys', label: 'API keys', icon: KeyRound, path: '/keys' },
  { key: 'logs', label: 'Logs', icon: ScrollText, path: '/logs' },
  { key: 'settings', label: 'Settings', icon: Settings, path: '/settings' },
] as const

export type SectionKey = (typeof SECTIONS)[number]['key']

// The breadcrumb bar atop the content panel. `title` may be a ReactNode so a
// sub-route page can render a deeper trail; `actions` puts page-level controls
// (Run/Save) beside the theme toggle.
function TopBar({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-5 py-1.5">
      <div className="order-1 mr-auto flex min-w-0 items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
        {typeof title === 'string' ? <span className="truncate font-medium text-foreground">{title}</span> : title}
      </div>
      {/* Page actions sit beside the title on a wide screen and on their own row on a narrow one. */}
      {actions ? (
        <div className="order-3 flex w-full flex-wrap items-center justify-end gap-x-2 gap-y-1 md:order-2 md:w-auto">
          {actions}
        </div>
      ) : null}
      <ThemeToggle className="order-2 md:order-3" />
    </header>
  )
}

// The window: a sidebar and a floating, rounded content panel on the `bg-shell`
// backdrop. `flush` drops the main region's padding and scroll for pages that
// manage their own full-height layout (the tool workbench). `confirmLeave`
// lets such a page veto sidebar navigation while it holds unsaved work.
export function AdminShell({
  active,
  title,
  actions,
  flush = false,
  confirmLeave,
  children,
}: {
  active: SectionKey
  title?: ReactNode
  actions?: ReactNode
  flush?: boolean
  confirmLeave?: () => boolean
  children: ReactNode
}) {
  const navigate = useNavigate()
  const location = useLocation()
  const status = useStatusStore((s) => s.status)
  const fetchStatus = useStatusStore((s) => s.fetchStatus)

  // Counts in the nav follow what the pages do, so refresh on every navigation
  // and whenever the keys this page has loaded change.
  const keyCount = useKeysStore((s) => s.keys.length)
  useEffect(() => {
    void fetchStatus()
  }, [fetchStatus, location.pathname, keyCount])

  const items: NavItemDef[] = SECTIONS.map(({ key, label, icon }) => ({
    key,
    label,
    icon,
    count: key === 'keys' ? status?.counts.keys : undefined,
  }))
  const section = SECTIONS.find((candidate) => candidate.key === active)!

  // The tab says which page it is on, for the tab strip and for a screen reader.
  useEffect(() => {
    document.title = `${section.label} · postgres2mcp`
  }, [section.label])

  return (
    <div className="min-h-screen bg-shell md:grid md:h-screen md:grid-cols-[240px_minmax(0,1fr)] md:overflow-hidden">
      <a
        href="#content"
        className="sr-only rounded-md bg-primary px-3 py-2 text-[0.8125rem] font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50"
      >
        Skip to content
      </a>
      <Sidebar
        items={items}
        active={active}
        onNavigate={(key) => {
          if (confirmLeave && !confirmLeave()) return
          navigate(SECTIONS.find((candidate) => candidate.key === key)!.path)
        }}
      />

      <div className="md:min-h-0 md:p-2.5 md:pl-0">
        <div className="flex min-h-screen flex-col border-border bg-background md:h-full md:min-h-0 md:overflow-hidden md:rounded-2xl md:border md:shadow-[0_1px_2px_rgba(22,28,45,0.05),0_12px_32px_-22px_rgba(22,28,45,0.30)]">
          <TopBar title={title ?? section.label} actions={actions} />
          <main
            id="content"
            tabIndex={-1}
            className={
              flush
                ? 'flex min-h-0 flex-1 flex-col outline-none'
                : 'flex-1 px-5 py-6 outline-none md:overflow-y-auto md:px-7 md:py-7 lg:px-9'
            }
          >
            {children}
          </main>
        </div>
      </div>
    </div>
  )
}
