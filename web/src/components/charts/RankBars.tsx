import type { ReactNode } from 'react'
import { formatInt } from '@/lib/format'

export interface RankRow {
  key: string
  label: string
  /** Mono for identifiers (tool names); sans for names people chose. */
  mono?: boolean
  value: number
  /** Quiet context after the value: average latency, error count. */
  note?: ReactNode
  onSelect?: () => void
}

// A ranked list with a bar per row: the same hue for every bar (the rows are
// names, not a scale), the value at the bar's tip, and the label in text ink.
// It is its own table view — every number is on the page, not behind a hover.
export function RankBars({ rows, unit }: { rows: RankRow[]; unit: string }) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <div className="flex flex-col">
      {rows.map((row) => {
        const body = (
          <>
            <span className={`w-28 shrink-0 truncate text-xs sm:w-40 ${row.mono ? 'font-mono' : ''}`} title={row.label}>
              {row.label}
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span
                className="h-2 shrink-0 rounded-r-[4px] bg-[var(--chart-ok)] transition-[filter] group-hover:brightness-110"
                style={{ width: `max(2px, calc((100% - 5.5rem) * ${row.value / max}))` }}
              />
              <span className="tabular shrink-0 font-mono text-xs font-medium">{formatInt(row.value)}</span>
            </span>
            <span className="tabular hidden w-36 shrink-0 truncate text-right text-xs text-muted-foreground sm:block">
              {row.note}
            </span>
          </>
        )
        const className = 'group flex h-8 w-full items-center gap-3 rounded-md px-2 text-left'
        return row.onSelect ? (
          <button
            key={row.key}
            type="button"
            title={`${row.label}: ${formatInt(row.value)} ${unit} — open in logs`}
            className={`${className} outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50`}
            onClick={row.onSelect}
          >
            {body}
          </button>
        ) : (
          <div key={row.key} className={className}>
            {body}
          </div>
        )
      })}
    </div>
  )
}
