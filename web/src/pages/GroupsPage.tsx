import { useEffect, useState } from 'react'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { GROUP_ID_RE } from '@/lib/sqlTemplate'
import type { ToolGroup } from '@/lib/types'
import { useCatalogStore } from '@/stores/catalogStore'
import { toastOutcome } from '@/stores/toastStore'
import { AdminShell } from '@/components/layout/AdminShell'
import { PageHeader } from '@/components/layout/PageHeader'
import { ErrorNote, Field } from '@/components/parts'
import { ToolChecklist } from '@/components/ToolChecklist'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Modal } from '@/components/ui/modal'
import { cn } from '@/lib/utils'

function GroupForm({ existing, onDone }: { existing: ToolGroup | null; onDone: () => void }) {
  const tools = useCatalogStore((s) => s.tools)
  const groups = useCatalogStore((s) => s.groups)
  const createGroup = useCatalogStore((s) => s.createGroup)
  const updateGroup = useCatalogStore((s) => s.updateGroup)

  const [id, setId] = useState(existing?.id ?? '')
  const [name, setName] = useState(existing?.name ?? '')
  const [description, setDescription] = useState(existing?.description ?? '')
  const [selected, setSelected] = useState<string[]>(existing?.tools ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const idError =
    existing === null && id !== '' && !GROUP_ID_RE.test(id)
      ? 'Start with a letter; lowercase letters, digits, - and _ only.'
      : existing === null && groups.some((group) => group.id === id)
        ? `A group “${id}” already exists.`
        : null

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    const input = { name: name.trim(), description: description.trim(), tools: selected }
    const failure = existing ? await updateGroup(existing.id, input) : await createGroup(id, input)
    setBusy(false)
    if (failure) setError(failure)
    else onDone()
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Id" help={existing ? undefined : 'What keys refer to. Cannot be changed later.'}>
          <Input
            autoFocus={existing === null}
            disabled={existing !== null}
            aria-invalid={idError !== null || undefined}
            className="font-mono"
            placeholder="support-desk"
            value={id}
            onChange={(e) => setId(e.target.value)}
          />
        </Field>
        <Field label="Name">
          <Input placeholder="Support desk" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      {idError ? <ErrorNote>{idError}</ErrorNote> : null}
      <Field label="Description">
        <Input
          placeholder="What this set of tools is for"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="space-y-1.5">
        <div className="text-[0.8125rem] font-medium">
          Tools <span className="font-normal text-muted-foreground">· {selected.length} selected</span>
        </div>
        <ToolChecklist tools={tools} groups={groups} selected={selected} onChange={setSelected} />
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || (existing === null && (id === '' || idError !== null))}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {existing ? 'Save changes' : 'Create group'}
        </Button>
      </div>
    </form>
  )
}

function GroupCard({
  group,
  onEdit,
  onDelete,
}: {
  group: ToolGroup
  onEdit?: () => void
  onDelete?: () => void
}) {
  const tools = useCatalogStore((s) => s.tools)
  const access = (name: string) => tools.find((tool) => tool.name === name)?.access
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className="text-[0.8125rem] font-semibold">{group.name}</h3>
            <span className="font-mono text-xs text-muted-foreground">{group.id}</span>
          </div>
          {group.description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{group.description}</p>
          ) : null}
        </div>
        {onEdit && onDelete ? (
          <div className="-mr-1.5 -mt-1.5 flex shrink-0 gap-0.5">
            <Button variant="ghost" size="icon" type="button" title="Edit" aria-label={`Edit ${group.id}`} onClick={onEdit}>
              <Pencil />
            </Button>
            <Button
              variant="destructive-ghost"
              size="icon"
              type="button"
              title="Delete"
              aria-label={`Delete ${group.id}`}
              onClick={onDelete}
            >
              <Trash2 />
            </Button>
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {group.id === 'all' ? (
          <span className="text-xs text-muted-foreground">All {group.tools.length} tools on this server.</span>
        ) : group.tools.length === 0 ? (
          <span className="text-xs text-muted-foreground">
            {group.id === 'custom' ? 'No custom tools yet.' : 'No tools.'}
          </span>
        ) : (
          group.tools.map((name) => (
            <Badge
              key={name}
              variant="outline"
              className={cn(
                'font-mono',
                access(name) === 'admin' && 'border-red-500/25 text-red-700 dark:text-red-300',
                access(name) === 'write' && 'border-amber-500/30 text-amber-700 dark:text-amber-300'
              )}
            >
              {name}
            </Badge>
          ))
        )}
      </div>
    </div>
  )
}

// Tool groups: the units access is granted in. Built-in groups ship with the
// server; custom groups bundle whatever a kind of client needs.
export function GroupsPage() {
  const groups = useCatalogStore((s) => s.groups)
  const loaded = useCatalogStore((s) => s.loaded)
  const error = useCatalogStore((s) => s.error)
  const fetchCatalog = useCatalogStore((s) => s.fetchCatalog)
  const deleteGroup = useCatalogStore((s) => s.deleteGroup)
  const [form, setForm] = useState<{ existing: ToolGroup | null } | null>(null)

  useEffect(() => {
    void fetchCatalog()
  }, [fetchCatalog])

  async function onDelete(group: ToolGroup) {
    if (!window.confirm(`Delete the group “${group.name}”? Keys that use it lose those tools.`)) return
    const failure = await deleteGroup(group.id)
    toastOutcome(failure, `Deleted ${group.name}`)
  }

  const custom = groups.filter((group) => !group.builtin)
  const builtin = groups.filter((group) => group.builtin)

  return (
    <AdminShell active="groups">
      <div className="mx-auto max-w-5xl space-y-8">
        <PageHeader
          title="Tool groups"
          subtitle="Create and manage groups of tools for which access can be controlled together."
          actions={
            <Button type="button" onClick={() => setForm({ existing: null })}>
              <Plus />
              New group
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
            <section className="space-y-2.5">
              <h2 className="text-[0.9375rem] font-semibold">Custom</h2>
              {custom.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-4 py-5 text-[0.8125rem] leading-relaxed text-muted-foreground">
                  No custom groups. Create one to bundle together tools for a specific use case e.g. customer support.
                  The group will then be grantable to API keys.
                </p>
              ) : (
                <div className="grid gap-3 md:grid-cols-2">
                  {custom.map((group) => (
                    <GroupCard
                      key={group.id}
                      group={group}
                      onEdit={() => setForm({ existing: group })}
                      onDelete={() => void onDelete(group)}
                    />
                  ))}
                </div>
              )}
            </section>
            <section className="space-y-2.5">
              <h2 className="text-[0.9375rem] font-semibold">Built-in</h2>
              <div className="grid gap-3 md:grid-cols-2">
                {builtin.map((group) => (
                  <GroupCard key={group.id} group={group} />
                ))}
              </div>
            </section>
          </>
        )}
      </div>

      <Modal
        open={form !== null}
        onClose={() => setForm(null)}
        title={form?.existing ? `Edit ${form.existing.name}` : 'New tool group'}
        className="max-w-2xl"
      >
        {form ? (
          <GroupForm key={form.existing?.id ?? 'new'} existing={form.existing} onDone={() => setForm(null)} />
        ) : null}
      </Modal>
    </AdminShell>
  )
}
