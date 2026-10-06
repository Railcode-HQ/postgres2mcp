import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { LogStatus, StatsRange, ToolAccess } from '@/lib/types'

// Shared building blocks for the surfaces made of numbers and records. Numbers
// are the product here, so everything tabular is mono + tabular-nums and aligns.

export type StatusTone = 'ok' | 'error' | 'warn' | 'muted'

// Status is the one place colour earns its keep on this otherwise-monochrome
// surface: a failed or refused call must be findable at a glance. Green = clear,
// red = stop, amber = withheld; everything else stays quiet.
export function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        tone === 'ok' && 'border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
        tone === 'error' && 'border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300',
        tone === 'warn' && 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
        tone === 'muted' && 'border-border bg-muted/60 text-muted-foreground'
      )}
    >
      {label}
    </Badge>
  )
}

export const LOG_TONE: Record<LogStatus, StatusTone> = { ok: 'ok', error: 'error', denied: 'warn' }

// What a tool can do to the database. Reading is the quiet default; anything
// that can change data says so.
const ACCESS: Record<ToolAccess, { tone: StatusTone; label: string }> = {
  read: { tone: 'muted', label: 'read-only' },
  write: { tone: 'warn', label: 'writes' },
  admin: { tone: 'error', label: 'admin' },
}

export function AccessBadge({ access }: { access: ToolAccess }) {
  return <StatusBadge tone={ACCESS[access].tone} label={ACCESS[access].label} />
}

export interface StatItem {
  label: string
  value: ReactNode
  hint?: ReactNode
  hero?: boolean
  tone?: StatusTone
}

// The signal strip above a page's detail. One number leads (hero); the rest are
// supporting context, hairline-separated.
export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      {/* Every cell draws its right and bottom rule; the outer ones are tucked under the frame, so the
          hairlines stay whole however the strip wraps. */}
      <div className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {items.map((item) => (
          <div key={item.label} className="border-b border-r border-border px-4 py-3">
            <div className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{item.label}</div>
            {/* A fixed-height line, so the hero's larger figure does not push its hint off its neighbours' baseline. */}
            <div
              className={cn(
                'mt-1 flex h-8 items-end font-mono font-semibold leading-none text-foreground',
                item.hero ? 'text-2xl' : 'text-lg',
                item.tone === 'error' && 'text-red-600 dark:text-red-400',
                item.tone === 'warn' && 'text-amber-700 dark:text-amber-400'
              )}
            >
              {item.value}
            </div>
            {item.hint ? <div className="mt-1.5 text-xs text-muted-foreground">{item.hint}</div> : null}
          </div>
        ))}
      </div>
    </div>
  )
}

const RANGES: StatsRange[] = ['1h', '24h', '7d', '30d']

// The window picker every chart on a page shares.
export function RangeToggle({ value, onChange }: { value: StatsRange; onChange: (range: StatsRange) => void }) {
  return (
    <div className="inline-flex rounded-md border border-border bg-card p-0.5" role="group" aria-label="Time range">
      {RANGES.map((range) => (
        <button
          key={range}
          type="button"
          aria-pressed={value === range}
          className={cn(
            'rounded px-2.5 py-1 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
            value === range ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
          onClick={() => onChange(range)}
        >
          {range}
        </button>
      ))}
    </div>
  )
}

// The frame a block of the Overview sits in: a hairline card with a small-caps
// title and optional right-hand meta.
export function Card({
  title,
  meta,
  className,
  bodyClassName,
  children,
}: {
  title: string
  meta?: ReactNode
  className?: string
  bodyClassName?: string
  children: ReactNode
}) {
  return (
    <section className={cn('overflow-hidden rounded-lg border border-border bg-card', className)}>
      <header className="flex min-h-9 items-center justify-between gap-3 border-b border-border bg-muted/40 px-3 py-1.5">
        <h2 className="text-[0.6875rem] font-semibold uppercase tracking-wider text-muted-foreground">{title}</h2>
        {meta}
      </header>
      <div className={cn('p-3', bodyClassName)}>{children}</div>
    </section>
  )
}

// A dot with a ring leaving it: the page is listening for calls right now.
export function ListeningDot() {
  return (
    <span aria-hidden="true" className="relative grid size-4 shrink-0 place-items-center">
      <span className="p2m-listen absolute size-2 rounded-full bg-primary" />
      <span className="size-2 rounded-full bg-primary" />
    </span>
  )
}

export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center text-[0.8125rem] text-muted-foreground',
        className
      )}
    >
      {children}
    </div>
  )
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
      <AlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  )
}

// A labeled filter <select>. `allLabel` is the "no filter" option; an empty value
// clears the filter.
export function FilterSelect({
  label,
  value,
  onChange,
  allLabel,
  options,
}: {
  label: string
  value: string | null
  onChange: (value: string | null) => void
  allLabel: string
  options: { value: string; label: string }[]
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{label}</span>
      <div className="relative">
        <select
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          className={cn(
            'h-8 w-full min-w-[8.5rem] appearance-none rounded-md border border-input bg-card px-2.5 pr-7 text-[0.8125rem] shadow-xs outline-none transition-colors',
            'focus:border-ring focus:ring-2 focus:ring-ring/25',
            value ? 'text-foreground' : 'text-muted-foreground'
          )}
        >
          <option value="">{allLabel}</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value} className="text-foreground">
              {opt.label}
            </option>
          ))}
        </select>
        <svg
          className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
    </label>
  )
}

// A titled block inside a drawer or modal.
export function DrawerSection({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2 py-3 first:pt-0">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>
        {meta}
      </div>
      {children}
    </section>
  )
}

// A label/value pair for drawer headers.
export function KeyVal({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 space-y-0.5">
      <div className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="tabular truncate font-mono text-[0.8125rem] text-foreground">{children}</div>
    </div>
  )
}

// A monospace block for raw payloads (SQL, JSON, config snippets).
export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        'tabular max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-foreground',
        className
      )}
    >
      {children}
    </pre>
  )
}

// A form row: label above, control below, optional help underneath. The help
// sits outside the <label> so it does not become part of the control's name.
export function Field({ label, help, children }: { label: string; help?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex flex-col gap-1.5">
        <span className="text-[0.8125rem] font-medium text-foreground">{label}</span>
        {children}
      </label>
      {help ? <span className="text-xs leading-relaxed text-muted-foreground">{help}</span> : null}
    </div>
  )
}
