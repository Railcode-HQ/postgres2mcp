import { useMemo, useState } from 'react'
import { ChevronRight, Eye, Search, Table2 } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { SchemaTable } from '@/lib/types'

// The console's right rail: what there is to query. Click a table to see its
// columns; click a name to drop it into the editor at the cursor.
export function SchemaRail({
  tables,
  loaded,
  error,
  onInsert,
  heading = true,
}: {
  tables: SchemaTable[]
  loaded: boolean
  error: string | null
  onInsert: (text: string) => void
  /** Off where the rail sits under a tab that already names it. */
  heading?: boolean
}) {
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())

  const needle = filter.trim().toLowerCase()
  const visible = useMemo(
    () =>
      needle === ''
        ? tables
        : tables.filter(
            (t) => t.name.toLowerCase().includes(needle) || t.columns.some((c) => c.name.toLowerCase().includes(needle))
          ),
    [tables, needle]
  )

  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-2 px-4 pb-2 pt-4">
        {heading ? (
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Schema</h3>
        ) : null}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            aria-label="Filter tables and columns"
            className="h-7 pl-7 text-xs"
            placeholder="Filter tables and columns"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!loaded ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="px-2 py-1 text-xs text-[var(--sq-error-ink)]">{error}</p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {tables.length === 0 ? 'No tables in this database yet.' : 'Nothing matches.'}
          </p>
        ) : (
          visible.map((t) => {
            const key = `${t.schema}.${t.name}`
            // A filter that matched on a column opens the table to show why.
            const expanded = open.has(key) || (needle !== '' && !t.name.toLowerCase().includes(needle))
            const qualified = t.schema === 'public' ? t.name : key
            const Icon = t.type === 'table' ? Table2 : Eye
            return (
              <div key={key}>
                <div className="group flex h-7 items-center rounded-md hover:bg-foreground/[0.04]">
                  <button
                    type="button"
                    aria-label={expanded ? `Collapse ${qualified}` : `Expand ${qualified}`}
                    aria-expanded={expanded}
                    className="grid size-6 shrink-0 place-items-center text-muted-foreground"
                    onClick={() => toggle(key)}
                  >
                    <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />
                  </button>
                  <button
                    type="button"
                    title={`Insert ${qualified} · ${t.type}`}
                    className="flex min-w-0 flex-1 items-center gap-1.5 pr-2 text-left"
                    onClick={() => onInsert(qualified)}
                  >
                    <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs">
                      {t.schema !== 'public' ? <span className="text-muted-foreground">{t.schema}.</span> : null}
                      {t.name}
                    </span>
                  </button>
                </div>
                {expanded ? (
                  <div className="mb-1 ml-3 border-l border-border pl-3">
                    {t.columns.map((c) => (
                      <button
                        key={c.name}
                        type="button"
                        title={`Insert ${c.name}`}
                        className="flex h-6 w-full items-center justify-between gap-2 rounded px-1.5 text-left hover:bg-foreground/[0.04]"
                        onClick={() => onInsert(c.name)}
                      >
                        <span
                          className={cn(
                            'truncate font-mono text-[11px]',
                            needle !== '' && c.name.toLowerCase().includes(needle) && 'text-[var(--sq-param-ink)]'
                          )}
                        >
                          {c.name}
                        </span>
                        <span className="shrink-0 truncate font-mono text-[10px] text-muted-foreground">{c.type}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
