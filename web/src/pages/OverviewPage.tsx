import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, KeyRound } from 'lucide-react'
import { formatCompact, formatDuration, formatInt, formatPercent } from '@/lib/format'
import { useKeysStore } from '@/stores/keysStore'
import { useLogsStore } from '@/stores/logsStore'
import { useOnboardingStore } from '@/stores/onboardingStore'
import { useStatusStore } from '@/stores/statusStore'
import { CallsChart, LatencyChart, OutcomeLegend, bucketTitle } from '@/components/charts/TimeCharts'
import { RankBars } from '@/components/charts/RankBars'
import { useMcpEndpoint } from '@/components/ConnectSnippet'
import { AdminShell } from '@/components/layout/AdminShell'
import { PageHeader } from '@/components/layout/PageHeader'
import { Card, EmptyState, ErrorNote, RangeToggle, StatStrip } from '@/components/parts'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { cn } from '@/lib/utils'
import { GetStarted } from '@/pages/GetStarted'

const RANGE_WORDS = { '1h': 'the last hour', '24h': 'the last 24 hours', '7d': 'the last 7 days', '30d': 'the last 30 days' }

function ViewToggle({ value, onChange }: { value: 'chart' | 'table'; onChange: (view: 'chart' | 'table') => void }) {
  return (
    <div className="inline-flex rounded border border-border p-px" role="group" aria-label="View">
      {(['chart', 'table'] as const).map((view) => (
        <button
          key={view}
          type="button"
          aria-pressed={value === view}
          className={cn(
            'rounded-[3px] px-1.5 py-px text-[0.6875rem] font-medium capitalize outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
            value === view ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => onChange(view)}
        >
          {view}
        </button>
      ))}
    </div>
  )
}

// The front page. On a server no client has used yet that is the first-run
// guide, until it is finished or skipped; otherwise it is the overview.
export function OverviewPage() {
  const done = useOnboardingStore((s) => s.done)
  const started = useOnboardingStore((s) => s.progress !== null)
  const reopened = useOnboardingStore((s) => s.reopened)
  const finish = useOnboardingStore((s) => s.finish)
  const fetchKeys = useKeysStore((s) => s.fetchKeys)
  // A guide already under way (or asked for again) is simply shown. Otherwise
  // it is offered once, on a fresh look at the keys, to a server none of whose
  // keys has ever been used.
  const [unused, setUnused] = useState<boolean | null>(null)
  const decided = done || started || reopened || unused !== null

  useEffect(() => {
    if (done || started || reopened) return
    let cancelled = false
    void fetchKeys().then(() => {
      if (!cancelled) setUnused(useKeysStore.getState().keys.every((key) => key.last_used_at === null))
    })
    return () => {
      cancelled = true
    }
  }, [done, started, reopened, fetchKeys])

  if (!decided) {
    return (
      <AdminShell active="overview">
        <span className="sr-only">Loading…</span>
      </AdminShell>
    )
  }
  if (!done && (started || reopened || unused === true)) {
    return (
      <AdminShell active="overview">
        <GetStarted onFinish={finish} />
      </AdminShell>
    )
  }
  return <Overview />
}

// What the server is doing: volume, outcomes and latency over a window, and
// which tools and callers account for it. Everything is derived from the log.
function Overview() {
  const navigate = useNavigate()
  const endpoint = useMcpEndpoint()
  const reopenGuide = useOnboardingStore((s) => s.reopen)
  const status = useStatusStore((s) => s.status)
  const stats = useLogsStore((s) => s.stats)
  const range = useLogsStore((s) => s.statsRange)
  const loading = useLogsStore((s) => s.statsLoading)
  const error = useLogsStore((s) => s.statsError)
  const setRange = useLogsStore((s) => s.setStatsRange)
  const fetchStats = useLogsStore((s) => s.fetchStats)
  const setFilter = useLogsStore((s) => s.setFilter)
  const clearFilters = useLogsStore((s) => s.clearFilters)
  const [view, setView] = useState<'chart' | 'table'>('chart')

  useEffect(() => {
    void fetchStats()
    const timer = window.setInterval(() => void fetchStats({ quiet: true }), 10_000)
    return () => window.clearInterval(timer)
  }, [fetchStats])

  const database = status?.database
  const totals = stats?.totals
  const executed = totals ? totals.ok + totals.errors : 0
  const busy = stats?.series.filter((point) => point.ok + point.errors + point.denied > 0) ?? []

  const openLogs = (filter: { tool?: string; key_id?: string }) => {
    clearFilters()
    if (filter.tool) setFilter('tool', filter.tool)
    if (filter.key_id) setFilter('key_id', filter.key_id)
    navigate('/logs')
  }

  return (
    <AdminShell active="overview">
      <div className="mx-auto max-w-6xl space-y-5">
        <PageHeader
          title="Overview"
          subtitle={
            database?.connected ? (
              <>
                <span className="font-mono">
                  {database.user}@{database.host ?? 'local'}/{database.name}
                </span>{' '}
                · PostgreSQL {database.server_version}
              </>
            ) : database ? (
              <span className="text-destructive">Database not connected — {database.error}</span>
            ) : (
              'Connecting…'
            )
          }
          actions={<RangeToggle value={range} onChange={setRange} />}
        />

        {status && status.counts.keys === 0 ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border border-primary/25 bg-primary/[0.04] px-4 py-3">
            <KeyRound className="size-4 shrink-0 text-primary" />
            <div className="min-w-0 flex-1 basis-64">
              <div className="text-[0.8125rem] font-medium">Create an API key to connect a client</div>
              <div className="text-xs leading-relaxed text-muted-foreground">
                An MCP client needs a key, and the key decides which of the {status.counts.tools} tools it can use.
              </div>
            </div>
            <Button asChild size="sm">
              <Link to="/keys">
                Create a key
                <ArrowRight />
              </Link>
            </Button>
          </div>
        ) : null}

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {/* Held at reduced opacity while a new window loads — no layout jump. */}
        <div className={cn('space-y-5 transition-opacity', loading && stats !== null && 'opacity-60')}>
          <StatStrip
            items={[
              { label: 'Calls', value: totals ? formatCompact(totals.calls) : '—', hero: true, hint: RANGE_WORDS[range] },
              {
                label: 'Errors',
                value: totals ? formatCompact(totals.errors) : '—',
                tone: totals && totals.errors > 0 ? 'error' : undefined,
                hint: executed > 0 ? `${formatPercent(totals!.errors, executed)} of calls that ran` : 'of calls that ran',
              },
              {
                label: 'Denied',
                value: totals ? formatCompact(totals.denied) : '—',
                tone: totals && totals.denied > 0 ? 'warn' : undefined,
                hint: 'key lacked access',
              },
              { label: 'Avg latency', value: executed > 0 ? formatDuration(totals!.avg_ms) : '—' },
              { label: 'p95 latency', value: executed > 0 ? formatDuration(totals!.p95_ms) : '—' },
              { label: 'Rows returned', value: totals ? formatCompact(totals.rows) : '—' },
            ]}
          />

          <div className="grid gap-4 lg:grid-cols-5">
            <Card
              title="Calls"
              className="lg:col-span-3"
              meta={
                <div className="flex items-center gap-3">
                  <OutcomeLegend />
                  <ViewToggle value={view} onChange={setView} />
                </div>
              }
            >
              {!stats ? (
                <div className="h-56" />
              ) : stats.totals.calls === 0 ? (
                <EmptyState className="h-56 py-0">No calls in {RANGE_WORDS[range]}.</EmptyState>
              ) : view === 'chart' ? (
                <div className="h-56">
                  <CallsChart series={stats.series} range={range} />
                </div>
              ) : (
                <div className="h-56 overflow-y-auto">
                  <table className="w-full border-collapse text-left text-xs">
                    <thead className="sticky top-0 bg-card text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                      <tr className="border-b border-border">
                        <th className="py-1.5 pr-3 font-medium">Period starting</th>
                        <th className="px-3 py-1.5 text-right font-medium">OK</th>
                        <th className="px-3 py-1.5 text-right font-medium">Denied</th>
                        <th className="px-3 py-1.5 text-right font-medium">Errors</th>
                        <th className="py-1.5 pl-3 text-right font-medium">Avg latency</th>
                      </tr>
                    </thead>
                    <tbody className="tabular font-mono">
                      {busy.map((point) => (
                        <tr key={point.t} className="border-b border-border/60">
                          <td className="py-1.5 pr-3 font-sans">{bucketTitle(point.t, range)}</td>
                          <td className="px-3 py-1.5 text-right">{formatInt(point.ok)}</td>
                          <td className="px-3 py-1.5 text-right">{formatInt(point.denied)}</td>
                          <td className="px-3 py-1.5 text-right">{formatInt(point.errors)}</td>
                          <td className="py-1.5 pl-3 text-right">
                            {point.ok + point.errors > 0 ? formatDuration(point.avg_ms) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card title="Average latency" className="lg:col-span-2">
              {!stats ? (
                <div className="h-56" />
              ) : executed === 0 ? (
                <EmptyState className="h-56 py-0">No calls ran in {RANGE_WORDS[range]}.</EmptyState>
              ) : (
                <div className="h-56">
                  <LatencyChart series={stats.series} range={range} />
                </div>
              )}
            </Card>
          </div>

          <div className="grid items-start gap-4 lg:grid-cols-2">
            <Card title="Most called tools" bodyClassName="p-1.5">
              {!stats || stats.by_tool.length === 0 ? (
                <p className="px-2 py-6 text-center text-[0.8125rem] text-muted-foreground">
                  No calls in {RANGE_WORDS[range]}.
                </p>
              ) : (
                <RankBars
                  unit="calls"
                  rows={stats.by_tool.map((row) => ({
                    key: row.tool,
                    label: row.tool,
                    mono: true,
                    value: row.calls,
                    note: `${formatDuration(row.avg_ms)} avg${row.errors > 0 ? ` · ${formatInt(row.errors)} failed` : ''}`,
                    onSelect: () => openLogs({ tool: row.tool }),
                  }))}
                />
              )}
            </Card>
            <Card title="Callers" bodyClassName="p-1.5">
              {!stats || stats.by_key.length === 0 ? (
                <p className="px-2 py-6 text-center text-[0.8125rem] text-muted-foreground">
                  No callers in {RANGE_WORDS[range]}.
                </p>
              ) : (
                <RankBars
                  unit="calls"
                  rows={stats.by_key.map((row) => ({
                    key: row.key_id ?? row.key_name,
                    // Calls made from here have no key; the log calls them "dashboard" too.
                    label: row.key_id === null && row.key_name === 'admin' ? 'dashboard' : row.key_name,
                    value: row.calls,
                    note: row.errors > 0 ? `${formatInt(row.errors)} failed` : row.key_id === null ? 'no key' : '',
                    onSelect: row.key_id !== null ? () => openLogs({ key_id: row.key_id! }) : undefined,
                  }))}
                />
              )}
            </Card>
          </div>
        </div>

        <Card title="MCP endpoint">
          <div className="flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 basis-48 break-all font-mono text-[0.8125rem]">{endpoint}</code>
            <CopyButton value={endpoint} label="Copy" />
            <Button type="button" variant="ghost" size="sm" onClick={reopenGuide}>
              Connect a client
              <ArrowRight />
            </Button>
          </div>
          {status ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {status.counts.tools} tools ({status.counts.custom_tools} custom) ·{' '}
              {status.counts.keys} API key{status.counts.keys === 1 ? '' : 's'} · results capped at{' '}
              {formatInt(status.limits.max_rows)} rows · statements time out after{' '}
              {formatDuration(status.limits.query_timeout_ms)}
            </p>
          ) : null}
        </Card>
      </div>
    </AdminShell>
  )
}
