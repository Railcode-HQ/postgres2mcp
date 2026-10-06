import { useEffect, useState } from 'react'
import { Loader2, Search, Trash2, X } from 'lucide-react'
import { formatAbsoluteTime, formatLogTime, formatDuration, formatInt, formatRelativeTime } from '@/lib/format'
import type { LogEntry, LogSource, LogStatus } from '@/lib/types'
import { useCatalogStore } from '@/stores/catalogStore'
import { useKeysStore } from '@/stores/keysStore'
import { useLogsStore } from '@/stores/logsStore'
import { toast } from '@/stores/toastStore'
import { JsonCode, SqlCode, SqlInline } from '@/components/code'
import { AdminShell } from '@/components/layout/AdminShell'
import { PageHeader } from '@/components/layout/PageHeader'
import {
  DrawerSection,
  EmptyState,
  ErrorNote,
  FilterSelect,
  KeyVal,
  ListeningDot,
  LOG_TONE,
  StatusBadge,
} from '@/components/parts'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Drawer } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const STATUS_OPTIONS: { value: LogStatus; label: string }[] = [
  { value: 'ok', label: 'OK' },
  { value: 'error', label: 'Error' },
  { value: 'denied', label: 'Denied' },
]

const SOURCE_OPTIONS: { value: LogSource; label: string }[] = [
  { value: 'mcp', label: 'MCP clients' },
  { value: 'admin', label: 'This dashboard' },
  { value: 'stdio', label: 'stdio' },
]

const SOURCE_LABEL: Record<LogSource, string> = {
  mcp: 'an MCP client',
  admin: 'this dashboard',
  stdio: 'the stdio transport',
}

const KIND_LABEL: Record<LogEntry['kind'], string> = {
  builtin: 'built-in tool',
  custom: 'custom tool',
  sql: 'SQL console',
  unknown: 'no such tool',
}

const ROW =
  'grid w-full grid-cols-[6.5rem_minmax(0,0.9fr)_minmax(0,1fr)_5rem_4.5rem_4rem_minmax(0,1.6fr)] items-center gap-3 px-4'

// A failure is red; a call the key was not allowed to make is amber, as everywhere.
const errorInk = (entry: LogEntry) => (entry.status === 'denied' ? 'text-[var(--sq-error-ink)]' : 'text-destructive')

/** Who made the call, as the tape and the drawer name them. */
const callerOf = (entry: LogEntry) => entry.key_name ?? (entry.source === 'stdio' ? 'stdio' : 'dashboard')

function LogDrawer({ entry, onClose }: { entry: LogEntry | null; onClose: () => void }) {
  // Keep the last entry rendered while the drawer slides shut.
  const [shown, setShown] = useState(entry)
  useEffect(() => {
    if (entry) setShown(entry)
  }, [entry])

  return (
    <Drawer
      open={entry !== null}
      onClose={onClose}
      eyebrow={shown ? `#${shown.id} · ${formatAbsoluteTime(shown.ts)}` : null}
      title={<span className="font-mono">{shown?.tool}</span>}
      meta={shown ? <StatusBadge tone={LOG_TONE[shown.status]} label={shown.status} /> : null}
    >
      {shown ? (
        <div className="divide-y divide-border">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 pb-3 sm:grid-cols-3">
            <KeyVal label="Caller">{callerOf(shown)}</KeyVal>
            <KeyVal label="Called from">{SOURCE_LABEL[shown.source]}</KeyVal>
            <KeyVal label="Tool type">{KIND_LABEL[shown.kind]}</KeyVal>
            <KeyVal label="Duration">{formatDuration(shown.duration_ms)}</KeyVal>
            <KeyVal label="Rows">{formatInt(shown.row_count)}</KeyVal>
            <KeyVal label="API key id">{shown.key_id ?? 'none'}</KeyVal>
          </div>
          {shown.error ? (
            <DrawerSection title={shown.status === 'denied' ? 'Denied' : 'Error'}>
              <p className={cn('whitespace-pre-wrap font-mono text-xs leading-relaxed', errorInk(shown))}>
                {shown.error}
              </p>
            </DrawerSection>
          ) : null}
          {shown.sql ? (
            <DrawerSection title="SQL" meta={<CopyButton value={shown.sql} size="sm" label="Copy" />}>
              <SqlCode sql={shown.sql} />
            </DrawerSection>
          ) : null}
          {shown.args ? (
            <DrawerSection title="Arguments">
              <JsonCode value={shown.args} />
            </DrawerSection>
          ) : null}
          {shown.client ? (
            <DrawerSection title="Client">
              <p className="break-all font-mono text-xs text-muted-foreground">{shown.client}</p>
            </DrawerSection>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  )
}

// The call log: every tool call, who made it, what SQL reached the database
// and how it ended.
export function LogsPage() {
  const logs = useLogsStore((s) => s.logs)
  const nextBefore = useLogsStore((s) => s.nextBefore)
  const filters = useLogsStore((s) => s.filters)
  const loading = useLogsStore((s) => s.loading)
  const loadingMore = useLogsStore((s) => s.loadingMore)
  const error = useLogsStore((s) => s.error)
  const fetchLogs = useLogsStore((s) => s.fetchLogs)
  const loadMore = useLogsStore((s) => s.loadMore)
  const setFilter = useLogsStore((s) => s.setFilter)
  const clearFilters = useLogsStore((s) => s.clearFilters)
  const clearLogs = useLogsStore((s) => s.clearLogs)
  const tools = useCatalogStore((s) => s.tools)
  const fetchCatalog = useCatalogStore((s) => s.fetchCatalog)
  const keys = useKeysStore((s) => s.keys)
  const fetchKeys = useKeysStore((s) => s.fetchKeys)

  const [selected, setSelected] = useState<LogEntry | null>(null)
  const [live, setLive] = useState(true)
  const [search, setSearch] = useState(filters.q)

  useEffect(() => {
    void fetchLogs()
    void fetchCatalog()
    void fetchKeys()
  }, [fetchLogs, fetchCatalog, fetchKeys])

  // Live tail: refresh the first page quietly. Paused while older pages are
  // loaded (a refresh would drop them) or a row is open.
  const paged = logs.length > 100
  useEffect(() => {
    if (!live || paged || selected !== null) return
    const timer = window.setInterval(() => void fetchLogs({ quiet: true }), 4000)
    return () => window.clearInterval(timer)
  }, [live, paged, selected, fetchLogs])

  // Search applies as typing settles.
  useEffect(() => {
    if (search === filters.q) return
    const timer = window.setTimeout(() => setFilter('q', search), 250)
    return () => window.clearTimeout(timer)
  }, [search, filters.q, setFilter])

  const hasFilters = Boolean(filters.status || filters.source || filters.tool || filters.key_id || filters.q)

  async function onClear() {
    if (
      !window.confirm(
        'Delete every log entry, not only the ones shown? The Overview is computed from the log, so its numbers start again from zero.'
      )
    ) {
      return
    }
    const deleted = await clearLogs()
    if (deleted !== null) {
      toast({ message: `Deleted ${deleted.toLocaleString()} log ${deleted === 1 ? 'entry' : 'entries'}` })
    }
  }

  return (
    <AdminShell active="logs">
      <div className="space-y-4">
        <PageHeader
          title="Logs"
          subtitle="Complete audit log of tool calls made via the MCP"
          actions={
            <>
              <Switch
                checked={live}
                onChange={setLive}
                label={live && (paged || selected !== null) ? 'Live (paused)' : 'Live'}
                title={
                  live && paged
                    ? 'Paused while older entries are loaded. Reload the page to follow new calls again.'
                    : live && selected !== null
                      ? 'Paused while an entry is open'
                      : 'Show new calls as they arrive'
                }
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void onClear()}
                disabled={logs.length === 0 && !hasFilters}
              >
                <Trash2 />
                Delete all logs
              </Button>
            </>
          }
        />

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-1 flex-col gap-1">
            <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Tool, SQL, arguments or error"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </label>
          <FilterSelect
            label="Status"
            value={filters.status}
            onChange={(value) => setFilter('status', value as LogStatus | null)}
            allLabel="Any status"
            options={STATUS_OPTIONS}
          />
          <FilterSelect
            label="Tool"
            value={filters.tool}
            onChange={(value) => setFilter('tool', value)}
            allLabel="Any tool"
            options={[...tools.map((tool) => ({ value: tool.name, label: tool.name })), { value: 'sql', label: 'sql (console)' }]}
          />
          <FilterSelect
            label="Caller"
            value={filters.key_id}
            onChange={(value) => setFilter('key_id', value)}
            allLabel="Any API key"
            options={keys.map((key) => ({ value: key.id, label: key.name }))}
          />
          <FilterSelect
            label="Called from"
            value={filters.source}
            onChange={(value) => setFilter('source', value as LogSource | null)}
            allLabel="Anywhere"
            options={SOURCE_OPTIONS}
          />
          {hasFilters ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearch('')
                clearFilters()
              }}
            >
              <X />
              Clear filters
            </Button>
          ) : null}
        </div>

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {logs.length === 0 ? (
          loading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <EmptyState>
              {hasFilters ? (
                <>
                  <p>No calls match these filters.</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSearch('')
                      clearFilters()
                    }}
                  >
                    <X />
                    Clear filters
                  </Button>
                </>
              ) : (
                <>
                  {live ? <ListeningDot /> : null}
                  <p className="max-w-md leading-relaxed">
                    No calls yet{live ? ', and listening' : ''}. Every tool call lands here as it happens, from a
                    client or from this dashboard, with its arguments and the SQL it ran.
                  </p>
                </>
              )}
            </EmptyState>
          )
        ) : (
          <div className={cn('overflow-x-auto rounded-lg border border-border bg-card', loading && 'opacity-60')}>
            <div className="min-w-[52rem]">
              <div
                className={cn(
                  ROW,
                  'h-8 border-b border-border bg-muted/40 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground'
                )}
              >
                <span>Time</span>
                <span>Caller</span>
                <span>Tool</span>
                <span>Status</span>
                <span className="text-right">Duration</span>
                <span className="text-right">Rows</span>
                <span>Detail</span>
              </div>
              <div className="divide-y divide-border">
                {logs.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={cn(
                      ROW,
                      'h-9 text-left text-[0.8125rem] outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50'
                    )}
                    onClick={() => setSelected(entry)}
                  >
                    <span
                      className="tabular font-mono text-xs text-muted-foreground"
                      title={`${formatAbsoluteTime(entry.ts)} · ${formatRelativeTime(entry.ts)}`}
                    >
                      {formatLogTime(entry.ts)}
                    </span>
                    <span className={cn('truncate', entry.key_name === null && 'text-muted-foreground')}>
                      {callerOf(entry)}
                    </span>
                    <span className="truncate font-mono text-xs">{entry.tool}</span>
                    <span>
                      <StatusBadge tone={LOG_TONE[entry.status]} label={entry.status} />
                    </span>
                    <span className="tabular text-right font-mono text-xs">{formatDuration(entry.duration_ms)}</span>
                    <span className="tabular text-right font-mono text-xs text-muted-foreground">
                      {entry.row_count === null ? '' : formatInt(entry.row_count)}
                    </span>
                    {entry.error ? (
                      <span className={cn('truncate font-mono text-xs', errorInk(entry))}>{entry.error}</span>
                    ) : entry.sql ? (
                      <SqlInline sql={entry.sql.slice(0, 400)} className="truncate text-xs" />
                    ) : (
                      <span />
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {nextBefore !== null ? (
          <div className="flex justify-center">
            <Button type="button" variant="outline" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore ? <Loader2 className="animate-spin" /> : null}
              Load older
            </Button>
          </div>
        ) : null}
      </div>

      <LogDrawer entry={selected} onClose={() => setSelected(null)} />
    </AdminShell>
  )
}
