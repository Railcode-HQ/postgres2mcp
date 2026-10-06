import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { formatDuration, formatInt } from '@/lib/format'
import type { LogEntry, ToolGroup } from '@/lib/types'
import { useCatalogStore } from '@/stores/catalogStore'
import { useKeysStore } from '@/stores/keysStore'
import { useOnboardingStore } from '@/stores/onboardingStore'
import { useStatusStore } from '@/stores/statusStore'
import { type ClientId, ConnectSnippet, useMcpEndpoint } from '@/components/ConnectSnippet'
import { BrandMark } from '@/components/BrandMark'
import { CodeBlock, ErrorNote, Field, ListeningDot, LOG_TONE, StatusBadge } from '@/components/parts'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

// What a first key may do. Three honest choices instead of the full picker;
// the API keys page has the rest.
const PRESETS = [
  {
    id: 'read',
    title: 'Read-only',
    note: 'Explore the schema and run SELECTs. Nothing it does can change data.',
    groups: ['schema', 'read'],
  },
  {
    id: 'custom',
    title: 'Read-only, plus custom tools',
    note: 'Also calls the custom tools you write, and can save a useful query as a tool itself. A custom tool writes only if you allow that tool to.',
    groups: ['schema', 'read', 'custom', 'authoring'],
  },
  {
    id: 'all',
    title: 'Everything',
    note: 'Every tool, including the ones that write, drop and truncate. For a database you would hand a psql prompt to.',
    groups: ['all'],
  },
] as const

type PresetId = (typeof PRESETS)[number]['id']

const toolCount = (groups: ToolGroup[], ids: readonly string[]) =>
  new Set(ids.flatMap((id) => groups.find((group) => group.id === id)?.tools ?? [])).size

type StepState = 'done' | 'active' | 'waiting'

// One step of the guide: a marker on a rail, a title, and either a one-line
// summary (done), the working area (active), or nothing yet (waiting).
function Step({
  number,
  title,
  state,
  summary,
  last = false,
  children,
}: {
  number: number
  title: string
  state: StepState
  summary?: ReactNode
  last?: boolean
  children?: ReactNode
}) {
  return (
    <li className="relative pb-7 pl-10 last:pb-0">
      {last ? null : <span aria-hidden="true" className="absolute bottom-0 left-3 top-7 w-px bg-border" />}
      <span
        aria-hidden="true"
        className={cn(
          'tabular absolute left-0 top-0 grid size-6 place-items-center rounded-full text-xs font-semibold',
          state === 'done' && 'bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950',
          state === 'active' && 'bg-primary text-primary-foreground',
          state === 'waiting' && 'border border-border bg-card text-muted-foreground'
        )}
      >
        {state === 'done' ? <Check className="size-3.5" strokeWidth={3} /> : number}
      </span>
      <h2
        className={cn(
          'flex min-h-6 items-center text-[0.9375rem] font-semibold',
          state === 'waiting' && 'text-muted-foreground'
        )}
      >
        {title}
        <span className="sr-only">
          {state === 'done' ? ' (done)' : state === 'active' ? ' (current step)' : ' (not started)'}
        </span>
      </h2>
      {state === 'done' && summary ? (
        <div className="mt-0.5 text-[0.8125rem] text-muted-foreground">{summary}</div>
      ) : null}
      {children ? <div className="mt-3 space-y-4">{children}</div> : null}
    </li>
  )
}

// The form behind step two.
function CreateKey({
  defaultName,
  onCreated,
  onCancel,
}: {
  defaultName: string
  onCreated: () => void
  onCancel?: () => void
}) {
  const groups = useCatalogStore((s) => s.groups)
  const createKey = useKeysStore((s) => s.createKey)
  const setCreated = useOnboardingStore((s) => s.setCreated)
  const [name, setName] = useState(defaultName)
  const [preset, setPreset] = useState<PresetId>('read')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const created = await createKey({
      name: name.trim(),
      groups: [...PRESETS.find((option) => option.id === preset)!.groups],
      tools: [],
      result_format: null,
    })
    setBusy(false)
    if ('error' in created) {
      setError(created.error)
      return
    }
    setCreated(created)
    onCreated()
  }

  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-4">
      <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
        A client connects with a key, and the key decides which tools it can see. Start narrow; you can change it at
        any time under API keys.
      </p>
      <fieldset className="overflow-hidden rounded-lg border border-border">
        <legend className="sr-only">What the key may do</legend>
        {PRESETS.map((option) => {
          const selected = preset === option.id
          return (
            <label
              key={option.id}
              className={cn(
                'flex cursor-pointer items-start gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0',
                selected ? 'bg-primary/[0.05]' : 'hover:bg-accent/50'
              )}
            >
              <input
                type="radio"
                name="access"
                className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
                checked={selected}
                onChange={() => setPreset(option.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="block text-[0.8125rem] font-medium">{option.title}</span>
                <span className="block text-xs leading-relaxed text-muted-foreground">{option.note}</span>
              </span>
              <span className="tabular shrink-0 font-mono text-xs text-muted-foreground">
                {groups.length > 0 ? `${toolCount(groups, option.groups)} tools` : ''}
              </span>
            </label>
          )
        })}
      </fieldset>
      <Field label="Name" help="Who or what will use the key. It is how its calls are labelled in the log.">
        <Input className="max-w-xs" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex items-center gap-2">
        <Button type="submit" disabled={busy || name.trim() === ''}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Create key
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  )
}

// The signal the page is waiting on, shown as it is: nothing yet, or a client
// that has reached the server. After a while with nothing, it says what to check.
function Listening({ connected, endpoint }: { connected: boolean; endpoint: string }) {
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    if (connected) return
    const timer = window.setTimeout(() => setStalled(true), 60_000)
    return () => window.clearTimeout(timer)
  }, [connected])

  return (
    <div role="status" className="rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-[0.8125rem]">
      <div className="flex items-center gap-3">
        <ListeningDot />
        {connected ? (
          <span>
            <span className="font-medium">Your client has connected.</span>{' '}
            <span className="text-muted-foreground">Waiting for its first tool call…</span>
          </span>
        ) : (
          <span className="text-muted-foreground">Listening for your client. This page updates when it connects.</span>
        )}
      </div>
      {stalled && !connected ? (
        <p className="mt-2 pl-7 text-xs leading-relaxed text-muted-foreground">
          Nothing yet. Some clients only read their configuration when they start, so restart yours after adding the
          server. It also has to be able to reach <span className="font-mono text-foreground">{endpoint}</span> from
          where it runs.
        </p>
      ) : null}
    </div>
  )
}

function FirstCall({ entry }: { entry: LogEntry }) {
  return (
    <div className="p2m-arrive overflow-hidden rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-[0.8125rem]">
        <StatusBadge tone={LOG_TONE[entry.status]} label={entry.status} />
        <span className="font-mono font-medium">{entry.tool}</span>
        <span className="text-muted-foreground">from {entry.key_name ?? 'a client'}</span>
        <span className="tabular ml-auto font-mono text-xs text-muted-foreground">
          {formatDuration(entry.duration_ms)}
          {entry.row_count !== null ? ` · ${formatInt(entry.row_count)} row${entry.row_count === 1 ? '' : 's'}` : ''}
        </span>
      </div>
      {entry.error ? (
        <p className="border-t border-emerald-500/20 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          The call reached the server and was answered with an error: {entry.error}
        </p>
      ) : null}
    </div>
  )
}

const NEXT = [
  { to: '/tools/new', title: 'Write a custom tool', note: 'Turn a query into a tool with typed arguments.' },
  { to: '/logs', title: 'Watch the calls come in', note: 'Every call, with its arguments and the SQL it ran.' },
  { to: '/keys', title: 'Give another client its own key', note: 'One key per client, each with its own access.' },
]

// The first-run guide: from an empty server to a client's first call, on the
// real thing. It stands in for the Overview until it is finished or skipped,
// and never blocks the rest of the dashboard.
export function GetStarted({ onFinish }: { onFinish: () => void }) {
  const status = useStatusStore((s) => s.status)
  const fetchStatus = useStatusStore((s) => s.fetchStatus)
  const keys = useKeysStore((s) => s.keys)
  const keysLoaded = useKeysStore((s) => s.loaded)
  const fetchKeys = useKeysStore((s) => s.fetchKeys)
  const fetchCatalog = useCatalogStore((s) => s.fetchCatalog)
  const schema = useCatalogStore((s) => s.schema)
  const schemaLoaded = useCatalogStore((s) => s.schemaLoaded)
  const fetchSchema = useCatalogStore((s) => s.fetchSchema)
  const created = useOnboardingStore((s) => s.created)
  const progress = useOnboardingStore((s) => s.progress)
  const begin = useOnboardingStore((s) => s.begin)
  const endpoint = useMcpEndpoint()

  const [firstCall, setFirstCall] = useState<LogEntry | null>(null)
  // Asked for from step three, when the key's token is no longer at hand.
  const [another, setAnother] = useState(false)
  const [client, setClient] = useState<ClientId>('claude')

  const database = status?.database
  const connected = database?.connected === true
  const hasKey = keys.length > 0
  // The client reaching the server at all: its key was used since the guide began.
  const clientSeen =
    progress !== null &&
    keys.some((key) => key.last_used_at !== null && Date.parse(key.last_used_at) >= Date.parse(progress.startedAt))
  // Until the keys have been read, neither later step can say where it stands.
  const ready = connected && keysLoaded
  const making = ready && (!hasKey || another)
  const connecting = ready && hasKey && !another
  const finished = firstCall !== null
  // Reopened on a server that clients already use, this is not anyone's first.
  const first = progress === null || progress.afterLog === 0

  useEffect(() => {
    void fetchCatalog()
    void fetchKeys()
  }, [fetchCatalog, fetchKeys])

  // The guide starts counting from what is already in the log, so that reopened
  // on a server in use it waits for a new call rather than finding an old one.
  useEffect(() => {
    if (progress !== null) return
    let cancelled = false
    void api
      .get<{ logs: LogEntry[] }>('/logs?source=mcp&limit=1')
      .then(
        (page) => page.logs[0]?.id ?? 0,
        () => 0
      )
      .then((newest) => {
        if (!cancelled) begin(newest)
      })
    return () => {
      cancelled = true
    }
  }, [progress, begin])

  useEffect(() => {
    if (connected && !schemaLoaded) void fetchSchema()
  }, [connected, schemaLoaded, fetchSchema])

  // A database that is down is checked again every few seconds, so fixing it is enough.
  useEffect(() => {
    if (database === undefined || connected) return
    const timer = window.setInterval(() => void fetchStatus(), 4000)
    return () => window.clearInterval(timer)
  }, [database, connected, fetchStatus])

  // Step three watches for the client: first its key being used, then a call in the log.
  useEffect(() => {
    if (!connecting || finished || progress === null) return
    let stopped = false
    const look = async () => {
      try {
        const [page] = await Promise.all([
          api.get<{ logs: LogEntry[] }>('/logs?source=mcp&limit=50'),
          fetchKeys(),
        ])
        // Newest first: the last one past the mark is the first call that arrived.
        const first = page.logs.filter((entry) => entry.id > progress.afterLog).at(-1)
        if (!stopped && first) setFirstCall(first)
      } catch {
        /* a missed beat; the next one is two seconds away */
      }
    }
    void look()
    const timer = window.setInterval(() => void look(), 2000)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [connecting, finished, progress, fetchKeys])

  const exampleTable = useMemo(() => {
    const table = schema.find((candidate) => candidate.type === 'table') ?? schema[0]
    return table ? (table.schema === 'public' ? table.name : `${table.schema}.${table.name}`) : null
  }, [schema])
  const prompt = exampleTable ? `How many rows are in ${exampleTable}?` : 'What tables are in this database?'

  // "12 tables, 3 views": what the client is about to be able to see.
  const relations = useMemo(() => {
    const tables = schema.filter((relation) => relation.type === 'table' || relation.type === 'foreign table').length
    const views = schema.length - tables
    const count = (n: number, word: string) => `${formatInt(n)} ${word}${n === 1 ? '' : 's'}`
    return [tables > 0 ? count(tables, 'table') : null, views > 0 ? count(views, 'view') : null]
      .filter(Boolean)
      .join(', ')
  }, [schema])

  const keyName = created?.key.name ?? keys[0]?.name

  // How long it took from opening the guide to the first call, when that is a
  // number worth saying.
  const took = useMemo(() => {
    if (firstCall === null || progress === null) return null
    const seconds = Math.round((Date.parse(firstCall.ts) - Date.parse(progress.startedAt)) / 1000)
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 3600) return null
    const minutes = Math.floor(seconds / 60)
    return minutes === 0 ? `${seconds} seconds` : `${minutes} min ${seconds % 60} s`
  }, [firstCall, progress])

  // The key and the snippets: the working part of step three, and still at
  // hand after the first call for whoever tried curl before their real client.
  const connectDetails = (
    <>
      {created ? (
        <div className="max-w-2xl space-y-1.5">
          <div className="text-[0.8125rem] font-medium">Your key</div>
          <div className="flex items-center gap-2">
            <CodeBlock className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap py-2">{created.token}</CodeBlock>
            <CopyButton value={created.token} label="Copy key" />
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            This is the only time it is shown: only its hash is stored. The snippet below already contains it, so
            copying the snippet is enough.
          </p>
        </div>
      ) : (
        <p className="max-w-xl text-[0.8125rem] leading-relaxed text-muted-foreground">
          A key is shown once, when it is created. If you no longer have{' '}
          {keys.length === 1 ? <span className="font-medium text-foreground">{keys[0]!.name}</span> : 'one'},{' '}
          <button
            type="button"
            className="font-medium text-primary underline-offset-4 outline-none hover:underline focus-visible:underline"
            onClick={() => setAnother(true)}
          >
            create another
          </button>
          . Existing keys keep working until you revoke them under API keys.
        </p>
      )}

      <div className="max-w-2xl space-y-1.5">
        <div className="text-[0.8125rem] font-medium">Add the server to your client</div>
        <ConnectSnippet token={created?.token} curl="call" client={client} onClientChange={setClient} />
      </div>
    </>
  )

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            {finished ? <BrandMark signal className="size-6 shrink-0" /> : null}
            {!finished
              ? first
                ? 'Connect your first client'
                : 'Connect a client'
              : first
                ? 'Your database is an MCP server'
                : 'Connected'}
          </h1>
          <p className="max-w-xl text-[0.8125rem] leading-relaxed text-muted-foreground">
            {finished
              ? first
                ? `A client asked, and the database answered${took ? `, ${took} after you opened this page` : ''}. Everything from here is refinement.`
                : 'The new client asked, and the database answered.'
              : 'A client is whatever will call the tools: Claude Code, Cursor, an agent of your own. Three steps, about two minutes, and you can leave and come back.'}
          </p>
        </div>
        {finished ? null : (
          <Button type="button" variant="ghost" onClick={onFinish}>
            {first ? 'Skip for now' : 'Close'}
          </Button>
        )}
      </div>

      <ol className="mt-7">
        <Step
          number={1}
          title={connected || database === undefined ? 'Database' : 'Database is not answering'}
          state={connected ? 'done' : 'active'}
          summary={
            database?.connected ? (
              <>
                <span className="font-mono text-foreground">
                  {database.user}@{database.host ?? 'local'}/{database.name}
                </span>{' '}
                · PostgreSQL {database.server_version}
                {relations ? ` · ${relations}` : ''}
              </>
            ) : undefined
          }
        >
          {connected ? null : database === undefined ? (
            <p className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              Checking the connection…
            </p>
          ) : (
            <div className="max-w-xl space-y-2">
              <ErrorNote>{database.error ?? 'The database did not answer.'}</ErrorNote>
              <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
                The server is running, but it cannot reach the database in <code className="font-mono">DATABASE_URL</code>.
                Check the host, the credentials and that the database accepts connections from this machine, then
                restart the server. This page checks again every few seconds.
              </p>
            </div>
          )}
        </Step>

        <Step
          number={2}
          title="Create a key"
          state={!ready ? 'waiting' : making ? 'active' : 'done'}
          summary={
            keyName ? (
              <>
                <span className="font-medium text-foreground">{keyName}</span>
                {keys.length > 1 ? ` and ${keys.length - 1} more` : ''} ·{' '}
                {(created?.key ?? keys[0])?.effective_tools.length ?? 0} tools
              </>
            ) : undefined
          }
        >
          {making ? (
            <CreateKey
              key={another ? 'another' : 'first'}
              defaultName={hasKey ? `client-${keys.length + 1}` : 'first-client'}
              onCreated={() => setAnother(false)}
              onCancel={another ? () => setAnother(false) : undefined}
            />
          ) : null}
        </Step>

        <Step
          number={3}
          title={finished ? (first ? 'First call received' : 'Call received') : 'Connect your client'}
          state={finished ? 'done' : connecting ? 'active' : 'waiting'}
          last
        >
          {finished ? (
            <div className="max-w-2xl space-y-6">
              <FirstCall entry={firstCall} />
              <div>
                <h3 className="text-[0.8125rem] font-medium">Where to go from here</h3>
                <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                  {NEXT.map((item) => (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        onClick={onFinish}
                        className="group flex items-center gap-3 px-3 py-2.5 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block text-[0.8125rem] font-medium">{item.title}</span>
                          <span className="block text-xs text-muted-foreground">{item.note}</span>
                        </span>
                        <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
              <Button type="button" onClick={onFinish}>
                Open the overview
                <ArrowRight />
              </Button>
              <details className="text-[0.8125rem]">
                <summary className="w-fit cursor-pointer text-muted-foreground outline-none hover:text-foreground focus-visible:underline">
                  Show the key and the connection snippets again
                </summary>
                <div className="mt-3 space-y-4">{connectDetails}</div>
              </details>
            </div>
          ) : connecting ? (
            <>
              {connectDetails}
              {client === 'curl' ? null : (
                <div className="max-w-2xl space-y-1.5">
                  <div className="text-[0.8125rem] font-medium">Then ask it something</div>
                  <div className="flex items-center gap-2">
                    <p className="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-[0.8125rem]">
                      {prompt}
                    </p>
                    <CopyButton value={prompt} label="Copy" />
                  </div>
                </div>
              )}
              <div className="max-w-2xl">
                <Listening connected={clientSeen} endpoint={endpoint} />
              </div>
            </>
          ) : null}
        </Step>
      </ol>
    </div>
  )
}
