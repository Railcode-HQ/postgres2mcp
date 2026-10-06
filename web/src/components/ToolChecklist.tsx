import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { AccessBadge } from '@/components/parts'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { ToolGroup, ToolInfo } from '@/lib/types'

// A searchable checklist of tools, sectioned by the group each ships in.
// `covered` marks tools the caller already has some other way (through a
// selected group): they show as ticked and locked, with the reason.
export function ToolChecklist({
  tools,
  groups,
  selected,
  onChange,
  covered,
  className,
}: {
  tools: ToolInfo[]
  groups: ToolGroup[]
  selected: string[]
  onChange: (next: string[]) => void
  covered?: Map<string, string>
  className?: string
}) {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()

  const sections = useMemo(
    () =>
      groups
        .filter((group) => group.builtin && group.id !== 'all')
        .map((group) => ({
          group,
          tools: tools.filter(
            (tool) =>
              group.tools.includes(tool.name) &&
              (needle === '' || tool.name.includes(needle) || tool.description.toLowerCase().includes(needle))
          ),
        }))
        .filter((section) => section.tools.length > 0),
    [groups, tools, needle]
  )

  const toggle = (name: string) =>
    onChange(selected.includes(name) ? selected.filter((n) => n !== name) : [...selected, name])

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border', className)}>
      <div className="relative border-b border-border">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          aria-label="Filter tools"
          className="h-8 rounded-none border-0 pl-8 shadow-none focus:ring-0"
          placeholder="Filter tools"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="max-h-64 overflow-y-auto">
        {sections.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">No tools match.</p>
        ) : (
          sections.map(({ group, tools: members }) => (
            <div key={group.id}>
              <div className="sticky top-0 border-b border-border bg-muted px-3 py-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.name}
              </div>
              {members.map((tool) => {
                const via = covered?.get(tool.name)
                return (
                  <label
                    key={tool.name}
                    className={cn(
                      'flex items-center gap-2.5 border-b border-border/60 px-3 py-1.5 last:border-b-0',
                      via ? 'cursor-default opacity-70' : 'cursor-pointer hover:bg-muted/50'
                    )}
                  >
                    <input
                      type="checkbox"
                      className="size-3.5 shrink-0 accent-[var(--primary)]"
                      checked={via !== undefined || selected.includes(tool.name)}
                      disabled={via !== undefined}
                      onChange={() => toggle(tool.name)}
                    />
                    <span className="w-40 shrink-0 truncate font-mono text-xs">{tool.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {via ? `included by ${via}` : tool.description}
                    </span>
                    {tool.access !== 'read' ? <AccessBadge access={tool.access} /> : null}
                  </label>
                )
              })}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
