import { useEffect, useState } from 'react'
import { Loader2, Pencil, Plus, Power, PowerOff, Trash2 } from 'lucide-react'
import { formatRelativeTime } from '@/lib/format'
import { formatLabel, RESULT_FORMATS } from '@/lib/resultFormats'
import type { ApiKey, ResultFormat } from '@/lib/types'
import { useCatalogStore } from '@/stores/catalogStore'
import { useKeysStore } from '@/stores/keysStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { toastOutcome } from '@/stores/toastStore'
import { ConnectSnippet } from '@/components/ConnectSnippet'
import { GrantPicker } from '@/components/GrantPicker'
import { AdminShell } from '@/components/layout/AdminShell'
import { PageHeader } from '@/components/layout/PageHeader'
import { CodeBlock, EmptyState, ErrorNote, Field, StatusBadge, type StatusTone } from '@/components/parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Modal } from '@/components/ui/modal'
import { cn } from '@/lib/utils'

// Create a key, or change what an existing one may call.
function KeyForm({
  existing,
  onDone,
  onCreated,
}: {
  existing: ApiKey | null
  onDone: () => void
  onCreated: (created: { key: ApiKey; token: string }) => void
}) {
  const tools = useCatalogStore((s) => s.tools)
  const groups = useCatalogStore((s) => s.groups)
  const createKey = useKeysStore((s) => s.createKey)
  const updateKey = useKeysStore((s) => s.updateKey)

  const [name, setName] = useState(existing?.name ?? '')
  // A new key starts read-only: enough to explore, nothing that can change data.
  const [selectedGroups, setSelectedGroups] = useState<string[]>(existing?.groups ?? ['schema', 'read'])
  const [selectedTools, setSelectedTools] = useState<string[]>(existing?.tools ?? [])
  const [format, setFormat] = useState<ResultFormat | null>(existing?.result_format ?? null)
  const defaultFormat = useSettingsStore((s) => s.settings?.result_format)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const input = { name: name.trim(), groups: selectedGroups, tools: selectedTools, result_format: format }
    if (existing) {
      const failure = await updateKey(existing.id, input)
      setBusy(false)
      if (failure) setError(failure)
      else onDone()
      return
    }
    const created = await createKey(input)
    setBusy(false)
    if ('error' in created) setError(created.error)
    else onCreated(created)
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Field label="Name" help="Who or what uses this key. It is how the key shows up in the logs.">
        <Input
          autoFocus
          placeholder="claude-desktop, support-bot, …"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="space-y-1.5">
        <div className="text-[0.8125rem] font-medium">Access</div>
        <p className="text-xs text-muted-foreground">
          Tick a group to grant all of it, or open it to pick individual tools.
        </p>
        <GrantPicker
          tools={tools}
          groups={groups}
          selectedGroups={selectedGroups}
          selectedTools={selectedTools}
          onGroupsChange={setSelectedGroups}
          onToolsChange={setSelectedTools}
        />
      </div>
      <Field label="Result format" help="How rows are written in this key's results.">
        <Select
          value={format ?? ''}
          onChange={(e) => setFormat(e.target.value === '' ? null : (e.target.value as ResultFormat))}
        >
          <option value="">Server default{defaultFormat ? ` (${formatLabel(defaultFormat)})` : ''}</option>
          {RESULT_FORMATS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || name.trim() === ''}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {existing ? 'Save changes' : 'Create key'}
        </Button>
      </div>
    </form>
  )
}

// API keys: one per client, each scoped to the tools that client should have.
export function KeysPage() {
  const keys = useKeysStore((s) => s.keys)
  const loaded = useKeysStore((s) => s.loaded)
  const error = useKeysStore((s) => s.error)
  const fetchKeys = useKeysStore((s) => s.fetchKeys)
  const updateKey = useKeysStore((s) => s.updateKey)
  const deleteKey = useKeysStore((s) => s.deleteKey)
  const groups = useCatalogStore((s) => s.groups)
  const tools = useCatalogStore((s) => s.tools)
  const fetchCatalog = useCatalogStore((s) => s.fetchCatalog)
  const fetchSettings = useSettingsStore((s) => s.fetchSettings)

  const [form, setForm] = useState<{ existing: ApiKey | null } | null>(null)
  const [revealed, setRevealed] = useState<{ key: ApiKey; token: string } | null>(null)

  useEffect(() => {
    void fetchKeys()
    void fetchCatalog()
    void fetchSettings()
  }, [fetchKeys, fetchCatalog, fetchSettings])

  async function onToggle(key: ApiKey) {
    const failure = await updateKey(key.id, { enabled: !key.enabled })
    toastOutcome(failure, key.enabled ? `Disabled ${key.name}. Its client is refused until you enable it again.` : `Enabled ${key.name}`)
  }

  async function onDelete(key: ApiKey) {
    if (!window.confirm(`Revoke “${key.name}”? Clients using it stop working immediately.`)) return
    const failure = await deleteKey(key.id)
    toastOutcome(failure, `Revoked ${key.name}`)
  }

  const groupName = (id: string) => groups.find((group) => group.id === id)?.name ?? id

  // The most a key can do, from the strongest of the tools it can call. Writing
  // custom tools is its own answer: powerful, but not the power to drop a table.
  const reach = (key: ApiKey): { tone: StatusTone; label: string } => {
    const callable = tools.filter((tool) => key.effective_tools.includes(tool.name))
    if (callable.some((tool) => tool.access === 'admin' && !tool.groups.includes('authoring'))) {
      return { tone: 'error', label: 'admin' }
    }
    if (callable.some((tool) => tool.access === 'write')) return { tone: 'warn', label: 'writes' }
    if (callable.some((tool) => tool.groups.includes('authoring'))) return { tone: 'warn', label: 'writes tools' }
    return { tone: 'muted', label: 'read-only' }
  }

  return (
    <AdminShell active="keys">
      <div className="mx-auto max-w-5xl space-y-6">
        <PageHeader
          title="API keys"
          subtitle="Create API keys and specify the tools they allow access to."
          actions={
            <Button type="button" onClick={() => setForm({ existing: null })}>
              <Plus />
              New key
            </Button>
          }
        />

        {error ? <ErrorNote>{error}</ErrorNote> : null}

        {!loaded ? (
          <div className="flex justify-center py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : keys.length === 0 ? (
          <EmptyState>
            <p className="max-w-md leading-relaxed">
              No API keys yet. An MCP client needs a key to connect, and the key decides which tools it can see — from
              read-only exploration to a single custom tool.
            </p>
            <Button type="button" variant="outline" size="sm" onClick={() => setForm({ existing: null })}>
              <Plus />
              Create the first key
            </Button>
          </EmptyState>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
            {keys.map((key) => (
              <div key={key.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className={cn('min-w-0 flex-1 basis-56', !key.enabled && 'opacity-60')}>
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[0.8125rem] font-medium">{key.name}</span>
                    {key.enabled ? null : <StatusBadge tone="muted" label="disabled" />}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="font-mono">{key.token_prefix}…</span>
                    <span>·</span>
                    <span>
                      {key.last_used_at ? `used ${formatRelativeTime(key.last_used_at)}` : 'never used'}
                    </span>
                    {key.result_format ? (
                      <>
                        <span>·</span>
                        <span>{formatLabel(key.result_format)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div
                  className={cn(
                    'flex min-w-0 flex-1 basis-64 flex-wrap items-center gap-1.5',
                    !key.enabled && 'opacity-60'
                  )}
                >
                  {key.groups.map((id) => (
                    <Badge key={id} variant="secondary">
                      {groupName(id)}
                    </Badge>
                  ))}
                  {key.tools.map((name) => (
                    <Badge key={name} variant="outline" className="font-mono">
                      {name}
                    </Badge>
                  ))}
                  {key.groups.length === 0 && key.tools.length === 0 ? (
                    <span className="text-xs text-muted-foreground">no access</span>
                  ) : null}
                </div>
                <span className="flex w-44 shrink-0 items-center justify-end gap-2">
                  {key.effective_tools.length > 0 && tools.length > 0 ? <StatusBadge {...reach(key)} /> : null}
                  <span className="tabular font-mono text-xs text-muted-foreground">
                    {key.effective_tools.length} tool{key.effective_tools.length === 1 ? '' : 's'}
                  </span>
                </span>
                <div className="flex shrink-0 gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    title="Change access"
                    aria-label={`Edit ${key.name}`}
                    onClick={() => setForm({ existing: key })}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    type="button"
                    title={key.enabled ? 'Disable' : 'Enable'}
                    aria-label={`${key.enabled ? 'Disable' : 'Enable'} ${key.name}`}
                    onClick={() => void onToggle(key)}
                  >
                    {key.enabled ? <PowerOff /> : <Power />}
                  </Button>
                  <Button
                    variant="destructive-ghost"
                    size="icon"
                    type="button"
                    title="Revoke"
                    aria-label={`Revoke ${key.name}`}
                    onClick={() => void onDelete(key)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <section className="space-y-2.5">
          <h2 className="text-[0.9375rem] font-semibold">Connecting a client</h2>
          <p className="text-[0.8125rem] text-muted-foreground">
            Clients reach this server over streamable HTTP and send the key as a bearer token.
          </p>
          <ConnectSnippet />
        </section>
      </div>

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.existing ? `Edit ${form.existing.name}` : 'New API key'}
        description={form?.existing ? 'Changes apply to the next request the key makes.' : undefined}
        className="max-w-2xl"
      >
        {form ? (
          <KeyForm
            key={form.existing?.id ?? 'new'}
            existing={form.existing}
            onDone={() => setForm(null)}
            onCreated={(created) => {
              setForm(null)
              setRevealed(created)
            }}
          />
        ) : null}
      </Modal>

      {/* The one moment the key exists in the clear: only its own button closes it. */}
      <Modal
        open={revealed !== null}
        onClose={() => setRevealed(null)}
        dismissible={false}
        title={`Key created: ${revealed?.key.name ?? ''}`}
        description="This is the only time the key is shown: only its hash is stored. Copy it, or a snippet that contains it, before closing."
        className="max-w-2xl"
      >
        {revealed ? (
          <div className="space-y-5">
            <div className="flex items-center gap-2">
              <CodeBlock className="min-w-0 flex-1 whitespace-nowrap py-2">{revealed.token}</CodeBlock>
              <CopyButton value={revealed.token} label="Copy key" />
            </div>
            <div className="space-y-2">
              <div className="text-[0.8125rem] font-medium">Connect a client</div>
              <ConnectSnippet token={revealed.token} />
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={() => setRevealed(null)}>
                I have copied it
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </AdminShell>
  )
}
