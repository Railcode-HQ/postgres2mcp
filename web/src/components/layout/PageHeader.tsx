import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

// The big title that sits at the top of a section's content panel — the same
// hierarchy core's admin uses (text-xl heading, muted subtitle, optional
// right-aligned actions).
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle ? (
          <div className="text-[0.8125rem] text-muted-foreground">{subtitle}</div>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  )
}

// A page section: an icon + heading, optional right-aligned meta (an action or
// short status), a hairline divider, then content sitting directly on the page —
// the same hierarchy core's admin uses for its connector/log sections.
export function Section({
  title,
  icon: Icon,
  meta,
  children,
}: {
  title: string
  icon: LucideIcon
  meta?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4 border-b border-border pb-2.5">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" />
          <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
        </div>
        {meta}
      </div>
      {children}
    </section>
  )
}

// A contained surface for a list of records: a hairline-bordered card whose
// rows are separated by hairlines. Pair with <ListRow>.
export function FramedList({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border bg-card',
        className
      )}
    >
      <div className="divide-y divide-border">{children}</div>
    </div>
  )
}

export function ListRow({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50',
        className
      )}
    >
      {children}
    </div>
  )
}
