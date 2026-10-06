import { lazy, Suspense, useEffect } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { Toaster } from '@/components/ui/toast'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/stores/authStore'
import { GroupsPage } from '@/pages/GroupsPage'
import { KeysPage } from '@/pages/KeysPage'
import { LoginPage, SetupPage } from '@/pages/LoginPage'
import { LogsPage } from '@/pages/LogsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { ToolsPage } from '@/pages/ToolsPage'

// The pages that carry weight load on demand: the two workbenches pull in
// Monaco, the overview pulls in the chart library.
const OverviewPage = lazy(() => import('@/pages/OverviewPage').then((m) => ({ default: m.OverviewPage })))
const ToolEditorPage = lazy(() => import('@/pages/ToolEditorPage').then((m) => ({ default: m.ToolEditorPage })))
const SqlConsolePage = lazy(() => import('@/pages/SqlConsolePage').then((m) => ({ default: m.SqlConsolePage })))

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center bg-shell px-4">{children}</div>
}

export function App() {
  const token = useAuthStore((s) => s.token)
  const setupRequired = useAuthStore((s) => s.setupRequired)
  const unreachable = useAuthStore((s) => s.unreachable)
  const init = useAuthStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  let screen: React.ReactNode
  if (unreachable) {
    screen = (
      <Centered>
        <div className="space-y-3 text-center">
          <p className="text-sm text-muted-foreground">Cannot reach the postgres2mcp server.</p>
          <Button type="button" variant="outline" onClick={() => void init()}>
            Try again
          </Button>
        </div>
      </Centered>
    )
  } else if (setupRequired === null) {
    screen = (
      <Centered>
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </Centered>
    )
  } else if (setupRequired) {
    screen = <SetupPage />
  } else if (token === null) {
    screen = <LoginPage />
  } else {
    screen = (
      <Suspense
        fallback={
          <Centered>
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </Centered>
        }
      >
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/tools/new" element={<ToolEditorPage />} />
          <Route path="/tools/:name" element={<ToolEditorPage />} />
          <Route path="/sql" element={<SqlConsolePage />} />
          <Route path="/keys" element={<KeysPage />} />
          <Route path="/groups" element={<GroupsPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    )
  }

  return (
    <>
      {screen}
      <Toaster />
    </>
  )
}
