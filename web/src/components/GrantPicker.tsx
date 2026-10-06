import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronRight, ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ToolGroup, ToolInfo } from '@/lib/types'

/* What an API key may call.
 *
 * One row per group. Ticking a row grants the WHOLE group — every tool in it
 * now, and any tool added to it later. Opening a row shows its tools, where
 * individual ones can be ticked instead: those are granted by name and nothing
 * else follows. The two map straight onto the key's `groups` and `tools`
 * lists, and the server resolves them the same way (groups ∪ tools), so the
 * summary underneath is exactly what the key will see.
 */
export function GrantPicker({
  tools,
  groups,
  selectedGroups,
  selectedTools,
  onGroupsChange,
  onToolsChange,
}: {
  tools: ToolInfo[]
  groups: ToolGroup[]
  selectedGroups: string[]
  selectedTools: string[]
  onGroupsChange: (next: string[]) => void
  onToolsChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState<Set<string>>(new Set())
  const everything = selectedGroups.includes('all')

  // Tool → the name of a selected group that already grants it.
  const viaGroup = useMemo(() => {
    const map = new Map<string, string>()
    for (const id of selectedGroups) {
      const group = groups.find((candidate) => candidate.id === id)
      for (const name of group?.tools ?? []) if (!map.has(name)) map.set(name, group!.name)
    }
    return map
  }, [groups, selectedGroups])

  const granted = (name: string) => viaGroup.has(name) || selectedTools.includes(name)
  const effective = tools.filter((tool) => granted(tool.name))
  const writes = effective.filter((tool) => tool.access === 'write').length
  const adminTools = effective.filter((tool) => tool.access === 'admin')
  const admin = adminTools.length
  // What "admin" amounts to for this selection, spelled out.
  const adminMeans = [
    adminTools.some((tool) => !tool.groups.includes('authoring')) ? 'drop, truncate, …' : null,
    adminTools.some((tool) => tool.groups.includes('authoring')) ? 'writing custom tools' : null,
  ]
    .filter(Boolean)
    .join('; ')

  const toggleGroup = (group: ToolGroup) => {
    if (selectedGroups.includes(group.id)) {
      onGroupsChange(selectedGroups.filter((id) => id !== group.id))
      return
    }
    onGroupsChange([...selectedGroups, group.id])
    // The group now covers these; individual grants for them would be noise.
    onToolsChange(selectedTools.filter((name) => !group.tools.includes(name)))
  }

  const toggleTool = (name: string) =>
    onToolsChange(selectedTools.includes(name) ? selectedTools.filter((n) => n !== name) : [...selectedTools, name])

  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })

  const all = groups.find((group) => group.id === 'all')
  const rows = groups.filter((group) => group.id !== 'all')

  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-lg border border-border">
        {all ? (
          <label
            className={cn(
              'flex cursor-pointer items-start gap-3 border-b border-border px-3 py-2.5',
              everything ? 'bg-primary/[0.05]' : 'bg-muted/30 hover:bg-accent/50'
            )}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-[var(--primary)]"
              checked={everything}
              onChange={() => toggleGroup(all)}
            />
            <span className="min-w-0 flex-1">
              <span className="block text-[0.8125rem] font-medium">Everything this server offers</span>
              <span className="block text-xs text-muted-foreground">
                All {all.tools.length} tools, and any added later — including the ones that write and destroy.
              </span>
            </span>
            <span className="font-mono text-xs text-muted-foreground">all</span>
          </label>
        ) : null}

        {rows.map((group) => (
          <GroupRow
            key={group.id}
            group={group}
            tools={tools}
            whole={selectedGroups.includes(group.id)}
            everything={everything}
            expanded={open.has(group.id)}
            granted={granted}
            viaGroup={viaGroup}
            selectedTools={selectedTools}
            onToggleGroup={() => toggleGroup(group)}
            onToggleTool={toggleTool}
            onToggleOpen={() => toggleOpen(group.id)}
          />
        ))}
      </div>

      <div
        className={cn(
          'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-relaxed',
          admin > 0 || writes > 0
            ? 'border-amber-500/30 bg-amber-500/[0.07] text-foreground'
            : 'border-border bg-muted/40 text-muted-foreground'
        )}
      >
        {admin > 0 || writes > 0 ? (
          <ShieldAlert className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        ) : null}
        <span>
          {effective.length === 0 ? (
            'This key cannot call anything yet. Tick a group, or open one and pick tools.'
          ) : (
            <>
              This key can call <span className="font-medium text-foreground">{effective.length}</span> tool
              {effective.length === 1 ? '' : 's'}
              {writes > 0 || admin > 0
                ? `, including ${[
                    writes > 0 ? `${writes} that can write data` : null,
                    admin > 0 ? `${admin} admin tool${admin === 1 ? '' : 's'} (${adminMeans})` : null,
                  ]
                    .filter(Boolean)
                    .join(' and ')}.`
                : ', all read-only.'}
            </>
          )}
        </span>
      </div>
    </div>
  )
}

function GroupRow({
  group,
  tools,
  whole,
  everything,
  expanded,
  granted,
  viaGroup,
  selectedTools,
  onToggleGroup,
  onToggleTool,
  onToggleOpen,
}: {
  group: ToolGroup
  tools: ToolInfo[]
  /** The group itself is selected. */
  whole: boolean
  /** "Everything" is selected, which covers this group too. */
  everything: boolean
  expanded: boolean
  granted: (name: string) => boolean
  viaGroup: Map<string, string>
  selectedTools: string[]
  onToggleGroup: () => void
  onToggleTool: (name: string) => void
  onToggleOpen: () => void
}) {
  const members = useMemo(
    () => group.tools.map((name) => tools.find((tool) => tool.name === name)).filter((tool) => tool !== undefined),
    [group.tools, tools]
  )
  const count = members.filter((tool) => granted(tool.name)).length
  const covered = whole || everything
  // Some of the group's tools are granted, but not the group itself.
  const partial = !covered && count > 0
  // The strongest thing in the group, so the choice is informed before it is made.
  const risk = members.some((tool) => tool.access === 'admin')
    ? 'admin'
    : members.some((tool) => tool.access === 'write')
      ? 'writes'
      : null

  // `indeterminate` is a DOM property, not an attribute.
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (box.current) box.current.indeterminate = partial
  }, [partial])

  return (
    <div className="border-b border-border/60 last:border-b-0">
      <div className={cn('flex items-center gap-3 px-3 py-2', covered ? 'bg-primary/[0.04]' : 'hover:bg-accent/50')}>
        <input
          ref={box}
          type="checkbox"
          aria-label={`Whole group: ${group.name}`}
          className="size-4 shrink-0 accent-[var(--primary)]"
          checked={covered}
          disabled={everything}
          onChange={onToggleGroup}
        />
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          onClick={onToggleOpen}
        >
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-[0.8125rem] font-medium">{group.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{group.id}</span>
              {!group.builtin ? <span className="text-[11px] text-muted-foreground">custom group</span> : null}
              {risk ? (
                <span
                  className={cn(
                    'text-[11px] font-medium uppercase tracking-wide',
                    risk === 'admin' ? 'text-red-700 dark:text-red-300' : 'text-amber-700 dark:text-amber-400'
                  )}
                >
                  {risk}
                </span>
              ) : null}
            </span>
            {group.description ? (
              <span className="block truncate text-xs text-muted-foreground">{group.description}</span>
            ) : null}
          </span>
          <span className="tabular shrink-0 font-mono text-xs text-muted-foreground">
            {covered ? `all ${members.length}` : partial ? `${count} of ${members.length}` : `${members.length}`}{' '}
            tool{members.length === 1 ? '' : 's'}
          </span>
          <ChevronRight
            className={cn('size-3.5 shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')}
          />
        </button>
      </div>

      {expanded ? (
        <div className="space-y-2 border-t border-border bg-muted/30 px-3 py-2.5">
          {members.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {group.id === 'custom' ? 'No custom tools yet — create one from the Tools page.' : 'This group has no tools.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
              {members.map((tool) => {
                const via = viaGroup.get(tool.name)
                return (
                  <label
                    key={tool.name}
                    title={via ? `${tool.description}\n\nIncluded by ${via}` : tool.description}
                    className={cn(
                      'flex items-center gap-2 text-xs',
                      via ? 'cursor-default text-muted-foreground' : 'cursor-pointer'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 shrink-0 accent-[var(--primary)]"
                      checked={via !== undefined || selectedTools.includes(tool.name)}
                      disabled={via !== undefined}
                      onChange={() => onToggleTool(tool.name)}
                    />
                    <span className="truncate font-mono">{tool.name}</span>
                    {tool.access !== 'read' ? (
                      <span
                        className={cn(
                          'shrink-0 text-[11px] uppercase tracking-wide',
                          tool.access === 'admin'
                            ? 'text-red-700 dark:text-red-300'
                            : 'text-amber-700 dark:text-amber-400'
                        )}
                      >
                        {tool.access === 'admin' ? 'admin' : 'writes'}
                      </span>
                    ) : null}
                  </label>
                )
              })}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {covered
              ? 'The whole group is granted, so tools added to it later are included.'
              : 'Ticked tools are granted by name. Tick the group itself to also include tools added to it later.'}
          </p>
        </div>
      ) : null}
    </div>
  )
}
