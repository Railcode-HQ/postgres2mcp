import { useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Link } from 'react-router-dom'
import { PARAM_NAME_RE } from '@/lib/sqlTemplate'
import type { ParamType, ToolGroup, ToolParam } from '@/lib/types'

const PARAM_TYPES: ParamType[] = ['string', 'int', 'float', 'bool']

interface ParamRailProps {
  /** Caller params derived live from the SQL, in first-occurrence order. */
  params: ToolParam[]
  values: Record<string, string>
  invalidValues: Set<string>
  /** Raw default inputs — a param is optional iff its name has an entry here. */
  defaults: Record<string, string>
  invalidDefaults: Set<string>
  descriptions: Record<string, string>
  onTypeChange: (name: string, type: ParamType) => void
  /** The "required" toggle: required=true removes the default entry. */
  onRequiredChange: (name: string, required: boolean) => void
  onDefaultChange: (name: string, value: string) => void
  onDescriptionChange: (name: string, value: string) => void
  onValueChange: (name: string, value: string) => void
  /** Writes ':name' into the SQL at the cursor. False when it landed where a placeholder is not read. */
  onAddParam: (name: string, type: ParamType) => boolean
  /** Rail hover → the editor flashes that param's occurrences. */
  onFlashParam: (name: string | null) => void
  toolName: string
  /** The custom groups that exist, and the ones this tool is in. */
  groups: ToolGroup[]
  selectedGroups: string[]
  onGroupsChange: (next: string[]) => void
}

const SLOT = 'w-20 shrink-0 text-[11px] uppercase tracking-wide text-muted-foreground'

// Params only exist as ':name' in the SQL, so adding one here writes it there.
function AddParam({ onAdd }: { onAdd: (name: string, type: ParamType) => boolean }) {
  const [name, setName] = useState('')
  const [type, setType] = useState<ParamType>('string')
  const [inert, setInert] = useState<string | null>(null)
  const trimmed = name.trim().replace(/^:/, '')
  const invalid = trimmed !== '' && !PARAM_NAME_RE.test(trimmed)

  function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (trimmed === '' || invalid) return
    setInert(onAdd(trimmed, type) ? null : trimmed)
    setName('')
  }

  return (
    <form className="flex flex-col gap-1.5" onSubmit={onSubmit}>
      <div className="flex items-center gap-1.5">
        <Input
          aria-label="New parameter name"
          aria-invalid={invalid || undefined}
          className="h-7 min-w-0 flex-1 font-mono text-xs"
          placeholder="name"
          spellCheck={false}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setInert(null)
          }}
        />
        <Select
          aria-label="New parameter type"
          className="w-[4.75rem] shrink-0"
          selectClassName="h-7 px-1.5 pr-6 text-[11px]"
          value={type}
          onChange={(e) => setType(e.target.value as ParamType)}
        >
          {PARAM_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline" size="sm" className="h-7 shrink-0" disabled={trimmed === '' || invalid}>
          <Plus />
          Add
        </Button>
      </div>
      {invalid ? (
        <p className="text-xs text-[var(--sq-error-ink)]">Letters, digits and underscores, not starting with a digit.</p>
      ) : inert ? (
        <p className="text-xs text-[var(--sq-error-ink)]">
          :{inert} went in at the cursor, inside a string or comment, where it is read as plain text. Move it into the
          statement.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">Adds it to the SQL at the cursor.</p>
      )}
    </form>
  )
}

// The right rail of the workbench: every ':name' the SQL mentions surfaces as a
// typed param with a description (what the MCP client's model reads), an
// optional default, and a test value for Run.
export function ParamRail({
  params,
  values,
  invalidValues,
  defaults,
  invalidDefaults,
  descriptions,
  onTypeChange,
  onRequiredChange,
  onDefaultChange,
  onDescriptionChange,
  onValueChange,
  onAddParam,
  onFlashParam,
  toolName,
  groups,
  selectedGroups,
  onGroupsChange,
}: ParamRailProps) {
  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto px-4 py-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Params</h3>
        {params.length === 0 ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Create parameters by adding{' '}
            <code className="rounded bg-[var(--sq-param-bg)] px-1 font-mono text-[var(--sq-param-ink)]">:</code> in
            front of the parameter name (e.g.{' '}
            <code className="rounded bg-[var(--sq-param-bg)] px-1 font-mono text-[var(--sq-param-ink)]">:name</code>).
            MCP clients can set the parameter and it is sent to Postgres as a bound value, never as SQL text.
          </p>
        ) : (
          params.map((p) => {
            const required = defaults[p.name] === undefined
            return (
              <div
                key={p.name}
                className="flex flex-col gap-1.5 rounded-md border border-border p-2.5 transition-colors hover:border-[color-mix(in_srgb,var(--ring)_45%,var(--border))]"
                onMouseEnter={() => onFlashParam(p.name)}
                onMouseLeave={() => onFlashParam(null)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-mono text-xs font-medium text-[var(--sq-param-ink)]">
                    :{p.name}
                  </span>
                  <Select
                    aria-label={`Type of param ${p.name}`}
                    className="w-[4.75rem] shrink-0"
                    selectClassName="h-6 px-1.5 pr-6 text-[11px]"
                    value={p.type}
                    onChange={(e) => onTypeChange(p.name, e.target.value as ParamType)}
                  >
                    {PARAM_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </Select>
                </div>
                <Input
                  aria-label={`Description of param ${p.name}`}
                  className="h-7 text-xs"
                  placeholder="What to pass — shown to the model"
                  value={descriptions[p.name] ?? ''}
                  onChange={(e) => onDescriptionChange(p.name, e.target.value)}
                />
                {/* Required by default; unticking reveals the default the server
                    binds when a caller omits the param. */}
                <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 accent-[var(--primary)]"
                    checked={required}
                    onChange={(e) => onRequiredChange(p.name, e.target.checked)}
                  />
                  required
                </label>
                {!required ? (
                  <div className="flex items-center gap-1.5">
                    <span className={SLOT}>default</span>
                    {p.type === 'bool' ? (
                      <Select
                        aria-label={`Default value for ${p.name}`}
                        selectClassName="h-7 font-mono text-xs"
                        value={defaults[p.name] ?? 'true'}
                        onChange={(e) => onDefaultChange(p.name, e.target.value)}
                      >
                        <option value="true">true</option>
                        <option value="false">false</option>
                      </Select>
                    ) : (
                      <Input
                        aria-label={`Default value for ${p.name}`}
                        aria-invalid={invalidDefaults.has(p.name) || undefined}
                        className="h-7 font-mono text-xs"
                        placeholder={p.type}
                        value={defaults[p.name] ?? ''}
                        onChange={(e) => onDefaultChange(p.name, e.target.value)}
                      />
                    )}
                  </div>
                ) : null}
                {/* Test value: only for Run, never saved. Left empty on an
                    optional param, the run omits it and exercises the default. */}
                <div className="flex items-center gap-1.5">
                  <span className={SLOT}>test value</span>
                  {p.type === 'bool' ? (
                    <Select
                      aria-label={`Test value for ${p.name}`}
                      selectClassName="h-7 font-mono text-xs"
                      value={values[p.name] ?? (p.default !== undefined ? '' : 'true')}
                      onChange={(e) => onValueChange(p.name, e.target.value)}
                    >
                      {p.default !== undefined ? <option value="">use default ({String(p.default)})</option> : null}
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </Select>
                  ) : (
                    <Input
                      aria-label={`Test value for ${p.name}`}
                      aria-invalid={invalidValues.has(p.name) || undefined}
                      className="h-7 font-mono text-xs"
                      placeholder={p.default !== undefined ? `default: ${String(p.default)}` : p.type}
                      value={values[p.name] ?? ''}
                      onChange={(e) => onValueChange(p.name, e.target.value)}
                    />
                  )}
                </div>
              </div>
            )
          })
        )}
        <AddParam onAdd={onAddParam} />
      </section>

      {/* Which keys can call the tool is decided by groups. Every custom tool is
          in "Custom tools" and "Everything"; custom groups are the opt-in ones. */}
      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Groups</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Always in <span className="font-medium text-foreground">Custom tools</span>. Add it to a group of your own
          to grant it alongside that group's other tools.
        </p>
        {groups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No custom groups yet —{' '}
            <Link
              to="/groups"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              create one
            </Link>{' '}
            (opens in a new tab, so this draft stays).
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-border">
            {groups.map((group) => (
              <label
                key={group.id}
                className="flex cursor-pointer items-center gap-2 border-b border-border/60 px-2.5 py-1.5 text-xs last:border-b-0 hover:bg-accent/50"
              >
                <input
                  type="checkbox"
                  className="size-3.5 shrink-0 accent-[var(--primary)]"
                  checked={selectedGroups.includes(group.id)}
                  onChange={() =>
                    onGroupsChange(
                      selectedGroups.includes(group.id)
                        ? selectedGroups.filter((id) => id !== group.id)
                        : [...selectedGroups, group.id]
                    )
                  }
                />
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{group.id}</span>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="mt-auto flex flex-col gap-1.5 border-t border-border pt-3">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Exposed as tool</h3>
        <code className="overflow-x-auto whitespace-nowrap rounded-md bg-muted px-2 py-1.5 font-mono text-[11px] text-muted-foreground">
          {toolName || 'name'}(
          {params.map((p) => `${p.name}${p.default !== undefined ? '?' : ''}: ${p.type}`).join(', ')})
        </code>
      </section>
    </div>
  )
}
