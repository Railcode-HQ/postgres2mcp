import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Loader2, Pencil, Play, Plus, Search, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { formatDuration, formatRelativeTime } from '@/lib/format'
import type { CustomTool, JsonSchema, ToolGroup, ToolInfo } from '@/lib/types'
import { useCatalogStore } from '@/stores/catalogStore'
import { useCustomToolsStore } from '@/stores/customToolsStore'
import { toastOutcome } from '@/stores/toastStore'
import { JsonCode, SqlCode } from '@/components/code'
import { AdminShell } from '@/components/layout/AdminShell'
import { PageHeader } from '@/components/layout/PageHeader'
import { AccessBadge, DrawerSection, EmptyState, ErrorNote } from '@/components/parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Drawer } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

// A starting point for the arguments box: every required argument, with a
// placeholder of the right type.
function exampleArguments(schema: JsonSchema): string {
  const example: Record<string, unknown> = {}
  for (const name of schema.required ?? []) {
    const type = schema.properties?.[name]?.type
    example[name] = type === 'integer' || type === 'number' ? 0 : type === 'boolean' ? false : type === 'array' ? [] : ''
  }
  return JSON.stringify(example, null, 2)
}

type CallState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'error'; message: string }
  | { phase: 'ok'; data: unknown; duration_ms: number }

function ToolDrawer({
  tool: current,
  custom,
  groups,
  onClose,
}: {
  tool: ToolInfo | null
  /** The custom tools, for the SQL behind one. */
  custom: CustomTool[]
  groups: ToolGroup[]
  onClose: () => void
}) {
  // Keep the last tool rendered while the drawer slides shut.
  const [tool, setTool] = useState(current)
  const [args, setArgs] = useState('{}')
  const [state, setState] = useState<CallState>({ phase: 'idle' })
  const name = current?.name

  useEffect(() => {
    if (current) setTool(current)
  }, [current])

  // A different tool starts from a clean form; a catalog refresh does not.
  useEffect(() => {
    if (!current) return
    setArgs(exampleArguments(current.input_schema))
    setState({ phase: 'idle' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name])

  async function onCall() {
    if (!tool) return
    let parsed: unknown
    try {
      parsed = JSON.parse(args.trim() === '' ? '{}' : args)
    } catch {
      setState({ phase: 'error', message: 'Arguments must be valid JSON.' })
      return
    }
    setState({ phase: 'running' })
    try {
      const result = await api.post<{ data: unknown; duration_ms: number }>(
        `/tools/${encodeURIComponent(tool.name)}/call`,
        { arguments: parsed }
      )
      setState({ phase: 'ok', data: result.data, duration_ms: result.duration_ms })
      // An authoring tool may have just changed the list this page shows.
      if (tool.groups.includes('authoring')) {
        void useCatalogStore.getState().fetchCatalog()
        void useCustomToolsStore.getState().fetchTools()
      }
    } catch (error) {
      const detail = error instanceof ApiError && error.hint ? `\nHint: ${error.hint}` : ''
      setState({ phase: 'error', message: `${error instanceof Error ? error.message : 'Call failed'}${detail}` })
    }
  }

  const source = tool?.kind === 'custom' ? custom.find((candidate) => candidate.name === tool.name) : undefined
  const properties = Object.entries(tool?.input_schema.properties ?? {})
  const required = new Set(tool?.input_schema.required ?? [])

  return (
    <Drawer
      open={current !== null}
      onClose={onClose}
      eyebrow={tool?.kind === 'custom' ? 'custom tool' : 'built-in tool'}
      title={<span className="font-mono">{tool?.name}</span>}
      meta={
        tool ? (
          <>
            <AccessBadge access={tool.access} />
            {tool.groups
              .filter((id) => id !== 'all')
              .map((id) => (
                <Badge key={id} variant="outline">
                  {groups.find((group) => group.id === id)?.name ?? id}
                </Badge>
              ))}
          </>
        ) : null
      }
    >
      {tool ? (
        <div className="divide-y divide-border">
          <DrawerSection title="Description">
            <p className="text-[0.8125rem] leading-relaxed">{tool.description}</p>
          </DrawerSection>

          {source ? (
            <DrawerSection
              title={`SQL · v${source.version}`}
              meta={
                <Button asChild variant="outline" size="sm">
                  <Link to={`/tools/${tool.name}`}>
                    <Pencil />
                    Edit
                  </Link>
                </Button>
              }
            >
              <SqlCode sql={source.sql} />
            </DrawerSection>
          ) : null}

          <DrawerSection title="Arguments">
            {properties.length === 0 ? (
              <p className="text-xs text-muted-foreground">This tool takes no arguments.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-border">
                {properties.map(([name, property]) => (
                  <div key={name} className="flex gap-3 border-b border-border px-3 py-2 last:border-b-0">
                    <div className="w-32 shrink-0">
                      <div className="truncate font-mono text-xs font-medium">{name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {property.type ?? 'any'}
                        {required.has(name) ? '' : ' · optional'}
                      </div>
                    </div>
                    <div className="min-w-0 text-xs leading-relaxed text-muted-foreground">
                      {property.description ?? (property.default === undefined ? 'No description.' : null)}
                      {property.default !== undefined ? (
                        <span className="font-mono">
                          {property.description ? ' ' : ''}default {JSON.stringify(property.default)}
                        </span>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </DrawerSection>

          <DrawerSection
            title="Try it"
            meta={
              <Button type="button" size="sm" onClick={onCall} disabled={state.phase === 'running'}>
                {state.phase === 'running' ? <Loader2 className="animate-spin" /> : <Play />}
                Call
              </Button>
            }
          >
            <Textarea
              aria-label="Arguments as JSON"
              className="min-h-24 font-mono text-xs"
              spellCheck={false}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
            />
            {tool.access !== 'read' ? (
              <p className="text-xs text-[var(--sq-error-ink)]">
                {tool.groups.includes('authoring')
                  ? 'This changes the custom tools on this server, for every key that can call them.'
                  : tool.access === 'admin'
                    ? 'This is an admin tool. Calling it here acts on the real database.'
                    : 'This tool can change data. Calling it here acts on the real database.'}
              </p>
            ) : null}
            {state.phase === 'error' ? (
              <ErrorNote>
                <span className="whitespace-pre-wrap font-mono">{state.message}</span>
              </ErrorNote>
            ) : null}
            {state.phase === 'ok' ? (
              <>
                <p className="tabular text-xs text-muted-foreground">Returned in {formatDuration(state.duration_ms)}</p>
                <JsonCode value={state.data} className="max-h-[26rem]" />
              </>
            ) : null}
          </DrawerSection>
        </div>
      ) : null}
    </Drawer>
  )
}

const signature = (tool: CustomTool) =>
  tool.params.map((p) => `${p.name}${p.default !== undefined ? '?' : ''}: ${p.type}`).join(', ')

const matchesSearch = (tool: { name: string; description: string }, needle: string) =>
  needle === '' || tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle)

const ROW =
  'flex w-full items-center gap-4 px-4 py-2.5 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50'

// Every tool this server can offer an MCP client: the ones you wrote, then the
// built-in ones by the group they ship in.
export function ToolsPage() {
  const navigate = useNavigate()
  const tools = useCatalogStore((s) => s.tools)
  const groups = useCatalogStore((s) => s.groups)
  const loaded = useCatalogStore((s) => s.loaded)
  const error = useCatalogStore((s) => s.error)
  const fetchCatalog = useCatalogStore((s) => s.fetchCatalog)
  const custom = useCustomToolsStore((s) => s.tools)
  const fetchTools = useCustomToolsStore((s) => s.fetchTools)
  const deleteTool = useCustomToolsStore((s) => s.deleteTool)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    void fetchCatalog()
    void fetchTools()
    // The editor is the heavy chunk; warm it so "New custom tool" opens instantly.
    void import('@/pages/ToolEditorPage')
  }, [fetchCatalog, fetchTools])

  // Built-in tools are listed once, under the group they ship in. Custom
  // groups are a way to grant, not a place to live.
  // The search looks at a tool's name and its description, nothing else.
  const needle = search.trim().toLowerCase()
  const sections = useMemo(
    () =>
      groups
        .filter((group) => group.builtin && group.id !== 'all' && group.id !== 'custom')
        .map((group) => ({
          group,
          tools: tools.filter((tool) => group.tools.includes(tool.name) && matchesSearch(tool, needle)),
        }))
        .filter((section) => section.tools.length > 0),
    [groups, tools, needle]
  )
  const shownCustom = custom.filter((tool) => matchesSearch(tool, needle))
  const groupName = (id: string) => groups.find((group) => group.id === id)?.name ?? id

  async function onDelete(name: string) {
    if (!window.confirm(`Delete the custom tool “${name}”? Clients that call it will be told it does not exist.`)) return
    const failure = await deleteTool(name)
    if (!failure) void fetchCatalog()
    toastOutcome(failure, `Deleted ${name}`)
  }

  return (
    <AdminShell active="tools">
      <div className="mx-auto max-w-5xl space-y-7">
        <PageHeader
          title="Tools"
          subtitle="Complete list of tools available in the MCP server. Granular tool access is controlled by API keys."
          actions={
            <Button asChild>
              <Link to="/tools/new">
                <Plus />
                New custom tool
              </Link>
            </Button>
          }
        />
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {!loaded ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="relative max-w-sm">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                aria-label="Search tools by name or description"
                className="pl-8"
                placeholder="Search tools by name or description"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            {needle !== '' && shownCustom.length === 0 && sections.length === 0 ? (
              <EmptyState>
                <p>No tool's name or description matches “{search.trim()}”.</p>
                <Button type="button" variant="outline" size="sm" onClick={() => setSearch('')}>
                  Clear search
                </Button>
              </EmptyState>
            ) : null}
            {needle !== '' && shownCustom.length === 0 ? null : (
              <section className="space-y-2.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <h2 className="text-[0.9375rem] font-semibold">Custom tools</h2>
                  <span className="text-[0.8125rem] text-muted-foreground">
                    Custom tools using parametrized SQL. Create one in the UI or with the MCP using a key with access
                    to tool creation.
                  </span>
                </div>
                {custom.length === 0 ? (
                  <EmptyState>
                    <p className="max-w-md leading-relaxed">
                      No custom tools yet. A custom tool is a SQL template with{' '}
                      <code className="rounded bg-[var(--sq-param-bg)] px-1 font-mono text-[var(--sq-param-ink)]">
                        :name
                      </code>{' '}
                      placeholders. Callers supply the values and never write the SQL, so you can hand a client one
                      exact question instead of the whole database.
                    </p>
                    <Button asChild variant="outline" size="sm">
                      <Link to="/tools/new">
                        <Plus />
                        Write the first one
                      </Link>
                    </Button>
                  </EmptyState>
                ) : (
                  <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                    {shownCustom.map((tool) => (
                      <div key={tool.name} className="flex items-stretch">
                        <button type="button" className={`${ROW} min-w-0 flex-1`} onClick={() => setSelected(tool.name)}>
                          <span className="w-44 shrink-0">
                            <span className="block truncate font-mono text-[0.8125rem] font-medium">{tool.name}</span>
                            <span className="block text-[11px] text-muted-foreground">
                              v{tool.version} · {formatRelativeTime(tool.updated_at)}
                            </span>
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[0.8125rem] text-muted-foreground">
                              {tool.description || 'No description — the model will have only the name to go on.'}
                            </span>
                            <span className="block truncate font-mono text-[11px] text-muted-foreground">
                              ({signature(tool)})
                            </span>
                          </span>
                          <span className="hidden shrink-0 items-center gap-1.5 md:flex">
                            {tool.groups.map((id) => (
                              <Badge key={id} variant="outline">
                                {groupName(id)}
                              </Badge>
                            ))}
                          </span>
                          <AccessBadge access={tool.allow_writes ? 'write' : 'read'} />
                        </button>
                        <div className="flex shrink-0 items-center gap-0.5 pr-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            type="button"
                            title="Edit"
                            aria-label={`Edit ${tool.name}`}
                            onClick={() => navigate(`/tools/${tool.name}`)}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            variant="destructive-ghost"
                            size="icon"
                            type="button"
                            title="Delete"
                            aria-label={`Delete ${tool.name}`}
                            onClick={() => void onDelete(tool.name)}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            {sections.map(({ group, tools: members }) => (
              <section key={group.id} className="space-y-2.5">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                  <h2 className="text-[0.9375rem] font-semibold">{group.name}</h2>
                  <span className="text-[0.8125rem] text-muted-foreground">{group.description}</span>
                </div>
                <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
                  {members.map((tool) => (
                    <button key={tool.name} type="button" className={ROW} onClick={() => setSelected(tool.name)}>
                      <span className="w-44 shrink-0 truncate font-mono text-[0.8125rem] font-medium">{tool.name}</span>
                      <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-muted-foreground">
                        {tool.description}
                      </span>
                      <AccessBadge access={tool.access} />
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}
      </div>
      <ToolDrawer
        tool={tools.find((tool) => tool.name === selected) ?? null}
        custom={custom}
        groups={groups}
        onClose={() => setSelected(null)}
      />
    </AdminShell>
  )
}
