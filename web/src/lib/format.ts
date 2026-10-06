// Display formatters. Numbers are the product on the log and stats surfaces,
// so these live together and render with tabular figures.

export function formatInt(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—'
  return value.toLocaleString()
}

/** 1,284 → "1,284"; 12,900 → "12.9K"; 4,200,000 → "4.2M". */
export function formatCompact(value: number): string {
  if (Math.abs(value) < 10_000) return value.toLocaleString()
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—'
  if (ms < 10) return `${ms.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} s`
}

export function formatRelativeTime(iso: string | null): string {
  if (iso === null) return 'never'
  const then = new Date(iso).getTime()
  const seconds = Math.round((Date.now() - then) / 1000)
  if (Number.isNaN(seconds)) return iso
  if (seconds < 5) return 'just now'
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export function formatAbsoluteTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}

/** The log tape's time column: the clock for today's entries, the date as well for older ones. */
export function formatLogTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const clock = date.toLocaleTimeString(undefined, { hour12: false })
  if (date.toDateString() === new Date().toDateString()) return clock
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clock.slice(0, 5)}`
}

export function formatPercent(part: number, whole: number): string {
  if (whole === 0) return '0%'
  const value = (part / whole) * 100
  return `${value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 })}%`
}
