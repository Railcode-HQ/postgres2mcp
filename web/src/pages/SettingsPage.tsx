import { useEffect, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { formatDuration, formatInt } from '@/lib/format'
import { RESULT_FORMATS } from '@/lib/resultFormats'
import type { ResultFormat } from '@/lib/types'
import { useAuthStore } from '@/stores/authStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useStatusStore } from '@/stores/statusStore'
import { toast, toastOutcome } from '@/stores/toastStore'
import { highlightJson } from '@/components/code'
import { AdminShell } from '@/components/layout/AdminShell'
import { PageHeader } from '@/components/layout/PageHeader'
import { CodeBlock, ErrorNote, Field } from '@/components/parts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

function Block({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-t border-border pt-6 first:border-t-0 first:pt-0 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <div className="space-y-1">
        <h2 className="text-[0.9375rem] font-semibold">{title}</h2>
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

function ResultFormatSetting() {
  const settings = useSettingsStore((s) => s.settings)
  const error = useSettingsStore((s) => s.error)
  const fetchSettings = useSettingsStore((s) => s.fetchSettings)
  const setResultFormat = useSettingsStore((s) => s.setResultFormat)
  const [saving, setSaving] = useState<ResultFormat | null>(null)

  useEffect(() => {
    void fetchSettings()
  }, [fetchSettings])

  async function choose(format: ResultFormat) {
    if (settings?.result_format === format) return
    setSaving(format)
    const failure = await setResultFormat(format)
    setSaving(null)
    toastOutcome(failure, `Results are now returned as ${RESULT_FORMATS.find((o) => o.value === format)!.label}`)
  }

  if (error) return <ErrorNote>{error}</ErrorNote>
  if (!settings) return <Loader2 className="size-4 animate-spin text-muted-foreground" />

  return (
    <div role="radiogroup" aria-label="Default result format" className="grid gap-3 xl:grid-cols-2">
      {RESULT_FORMATS.map((option) => {
        const active = settings.result_format === option.value
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => void choose(option.value)}
            className={cn(
              'flex min-w-0 flex-col gap-2 rounded-lg border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40',
              active ? 'border-primary bg-primary/[0.04]' : 'border-border hover:bg-muted/50'
            )}
          >
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'grid size-4 shrink-0 place-items-center rounded-full border',
                  active ? 'border-primary bg-primary text-primary-foreground' : 'border-input'
                )}
              >
                {saving === option.value ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : active ? (
                  <Check className="size-3" strokeWidth={3} />
                ) : null}
              </span>
              <span className="text-[0.8125rem] font-medium">{option.label}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{option.value}</span>
            </span>
            <span className="text-xs leading-relaxed text-muted-foreground">{option.blurb}</span>
            {/* Shown exactly as it is sent — compact JSON really is one line. */}
            <CodeBlock className={cn('max-h-40 text-[11px]', option.language === 'text' && 'whitespace-pre')}>
              {option.language === 'json' ? highlightJson(option.sample) : option.sample}
            </CodeBlock>
          </button>
        )
      })}
    </div>
  )
}

function PasswordSetting() {
  const username = useAuthStore((s) => s.username)
  const changePassword = useAuthStore((s) => s.changePassword)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [repeat, setRepeat] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [nextLeft, setNextLeft] = useState(false)
  const [repeatLeft, setRepeatLeft] = useState(false)

  const tooShort = nextLeft && next !== '' && next.length < 8
  const mismatch = repeat !== '' && repeat !== next && (repeatLeft || repeat.length >= next.length)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    const failure = await changePassword(current, next)
    setBusy(false)
    setError(failure)
    if (failure) return
    setCurrent('')
    setNext('')
    setRepeat('')
    setNextLeft(false)
    setRepeatLeft(false)
    toast({ message: 'Password changed. Other sessions of this account were signed out.' })
  }

  return (
    <form onSubmit={onSubmit} className="max-w-sm space-y-4">
      <p className="text-[0.8125rem] text-muted-foreground">
        Signed in as <span className="font-medium text-foreground">{username ?? '…'}</span>.
      </p>
      {/* Lets a password manager file the new password under the right account. */}
      <input type="text" name="username" autoComplete="username" value={username ?? ''} readOnly hidden />
      <Field label="Current password">
        <Input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(e) => {
            setCurrent(e.target.value)
            setError(null)
          }}
        />
      </Field>
      <Field label="New password" help={tooShort ? undefined : 'At least 8 characters.'}>
        <Input
          type="password"
          autoComplete="new-password"
          aria-invalid={tooShort || undefined}
          value={next}
          onBlur={() => setNextLeft(true)}
          onChange={(e) => setNext(e.target.value)}
        />
      </Field>
      {tooShort ? <ErrorNote>The password needs at least 8 characters.</ErrorNote> : null}
      <Field label="Repeat new password">
        <Input
          type="password"
          autoComplete="new-password"
          aria-invalid={mismatch || undefined}
          value={repeat}
          onBlur={() => setRepeatLeft(true)}
          onChange={(e) => setRepeat(e.target.value)}
        />
      </Field>
      {mismatch ? <ErrorNote>The two passwords do not match.</ErrorNote> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <Button type="submit" disabled={busy || current === '' || next.length < 8 || repeat !== next}>
        {busy ? <Loader2 className="animate-spin" /> : null}
        Change password
      </Button>
    </form>
  )
}

function Limits() {
  const status = useStatusStore((s) => s.status)
  if (!status) return <Loader2 className="size-4 animate-spin text-muted-foreground" />
  const rows = [
    ['Rows per result', formatInt(status.limits.max_rows), 'P2M_MAX_ROWS'],
    ['Statement timeout', formatDuration(status.limits.query_timeout_ms), 'P2M_QUERY_TIMEOUT_MS'],
    [
      'Log retention',
      status.limits.log_retention_days === 0 ? 'forever' : `${status.limits.log_retention_days} days`,
      'P2M_LOG_RETENTION_DAYS',
    ],
    ['Version', status.version, null],
  ] as const
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {rows.map(([label, value, env]) => (
        <div key={label} className="flex items-center gap-4 border-b border-border/60 px-3 py-2 text-[0.8125rem] last:border-b-0">
          <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
          <span className="tabular min-w-0 flex-1 font-mono">{value}</span>
          {env ? <code className="shrink-0 font-mono text-[11px] text-muted-foreground">{env}</code> : null}
        </div>
      ))}
    </div>
  )
}

export function SettingsPage() {
  return (
    <AdminShell active="settings">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader title="Settings" />
        <div className="space-y-6">
          <Block
            title="Result format"
            description="How rows are written into a tool's result. This is the default; an API key can choose its own. Answers that are not rows (a table's description, a query plan) are always JSON."
          >
            <ResultFormatSetting />
          </Block>
          <Block
            title="Account"
            description="Changing your password signs out the other sessions of this account."
          >
            <PasswordSetting />
          </Block>
          <Block
            title="Limits"
            description="Set when the server starts, through flags or the environment variables shown."
          >
            <Limits />
          </Block>
        </div>
      </div>
    </AdminShell>
  )
}
