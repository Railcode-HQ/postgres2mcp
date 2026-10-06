import { AlertCircle, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { formatDuration } from '@/lib/format'
import type { QueryResult } from '@/lib/types'

export type RunState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'error'; message: string; detail?: string | null; hint?: string | null }
  | { phase: 'ok'; result: QueryResult; writesEnabled: boolean }

interface ResultsDockProps {
  state: RunState
  runKeyHint: string
  /** "Allow writes" is on — the idle hint says so. */
  writesArmed?: boolean
  /** What the idle line promises about a run when writes are off. */
  idleNote?: string
}

function Cell({ value }: { value: unknown }) {
  if (value === null) return <span className="italic text-muted-foreground/70">null</span>
  if (typeof value === 'object') return <>{JSON.stringify(value)}</>
  return <>{String(value)}</>
}

// The meter at the bottom of the workbench: idle hint, running line, the
// database's error in its own words, or the result table with its meta strip.
export function ResultsDock({
  state,
  runKeyHint,
  writesArmed = false,
  idleNote = 'runs in a read-only transaction',
}: ResultsDockProps) {
  if (state.phase === 'idle') {
    return (
      <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-5 text-xs text-muted-foreground">
        Run to see results
        <kbd className="rounded border border-border bg-muted px-1 py-px font-sans text-xs">{runKeyHint}</kbd>
        {writesArmed ? (
          <span className="text-[var(--sq-error-ink)]">— writes are on: the statement can change data</span>
        ) : (
          <span>— {idleNote}</span>
        )}
      </div>
    )
  }

  if (state.phase === 'running') {
    return (
      <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border px-5 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Running…
      </div>
    )
  }

  if (state.phase === 'error') {
    // The server's hint is written for an MCP client. Here the way past a
    // read-only refusal is the switch in the top bar.
    const hint =
      state.hint && /read-only/i.test(state.hint) && !writesArmed
        ? 'This ran read-only. Turn on “Allow writes” above to let it change data.'
        : state.hint
    return (
      <div
        role="alert"
        className="max-h-[30%] shrink-0 overflow-y-auto border-t border-border px-5 py-3 font-mono text-xs leading-relaxed"
      >
        <p className="flex gap-2 text-destructive">
          <AlertCircle aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap">{state.message}</span>
        </p>
        <div className="space-y-1 pl-[1.375rem] pt-1">
          {state.detail ? <p className="text-muted-foreground">Detail: {state.detail}</p> : null}
          {hint ? <p className="text-muted-foreground">Hint: {hint}</p> : null}
        </div>
      </div>
    )
  }

  const { result, writesEnabled } = state
  const hasRows = result.columns.length > 0
  return (
    <div className="flex h-[38%] min-h-44 shrink-0 flex-col border-t border-border">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border px-5 text-xs text-muted-foreground">
        <span className="tabular font-medium text-foreground">
          {hasRows
            ? `${result.row_count.toLocaleString()} row${result.row_count === 1 ? '' : 's'}`
            : `${result.command ?? 'OK'}${result.row_count > 0 ? ` ${result.row_count.toLocaleString()}` : ''}`}
        </span>
        <span className="tabular">{formatDuration(result.duration_ms)}</span>
        {writesEnabled ? <span className="font-medium text-[var(--sq-error-ink)]">ran with writes on</span> : null}
        {result.truncated ? (
          <Badge variant="secondary" title="The row or size limit cut this result short">
            truncated
          </Badge>
        ) : null}
      </div>
      {!hasRows ? (
        <p className="px-5 py-3 text-xs text-muted-foreground">
          Statement ran
          {result.row_count > 0
            ? ` — ${result.row_count.toLocaleString()} row${result.row_count === 1 ? '' : 's'} affected.`
            : ' — no result set to show.'}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                {result.columns.map((c, i) => (
                  <th
                    key={i}
                    className="whitespace-nowrap border-b border-border px-3 py-1.5 font-mono font-medium text-muted-foreground first:pl-5 last:pr-5"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular font-mono">
              {result.rows.map((row, i) => (
                <tr key={i} className="border-b border-border/60 hover:bg-muted/40">
                  {row.map((cell, j) => (
                    <td key={j} className="max-w-[28rem] truncate whitespace-nowrap px-3 py-1 first:pl-5 last:pr-5">
                      <Cell value={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
