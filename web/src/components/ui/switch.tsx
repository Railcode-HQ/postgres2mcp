import { cn } from '@/lib/utils'

// A small labelled switch. `tone="caution"` turns it amber when on — for the
// settings that widen what can be done (allowing writes), which should read as
// deliberate rather than ambient.
export function Switch({
  checked,
  onChange,
  label,
  title,
  tone = 'default',
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  title?: string
  tone?: 'default' | 'caution'
  disabled?: boolean
}) {
  const caution = tone === 'caution' && checked
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!checked)}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        caution
          ? 'text-[var(--sq-error-ink)]'
          : checked
            ? 'text-foreground'
            : 'text-muted-foreground hover:text-foreground'
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'relative h-3.5 w-6 shrink-0 rounded-full border transition-colors',
          caution
            ? 'border-[var(--sq-error-ink)] bg-[var(--sq-error-bg)]'
            : checked
              ? 'border-primary bg-primary/15'
              : 'border-border bg-muted'
        )}
      >
        <span
          className={cn(
            'absolute top-1/2 size-2.5 -translate-y-1/2 rounded-full transition-[left]',
            caution
              ? 'left-[11px] bg-[var(--sq-error-ink)]'
              : checked
                ? 'left-[11px] bg-primary'
                : 'left-0.5 bg-muted-foreground/60'
          )}
        />
      </span>
      {label}
    </button>
  )
}
