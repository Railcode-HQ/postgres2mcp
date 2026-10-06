import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Loader2, Play } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { type monaco, setSchemaCompletions } from '@/lib/monacoSql'
import { hasMultipleStatements, placeholderNames, TOOL_NAME_RE } from '@/lib/sqlTemplate'
import type { CustomTool, ParamType, ParamValue, ToolParam } from '@/lib/types'
import { useCatalogStore } from '@/stores/catalogStore'
import { useCustomToolsStore } from '@/stores/customToolsStore'
import { AdminShell } from '@/components/layout/AdminShell'
import { ErrorNote } from '@/components/parts'
import { MonacoSqlEditor } from '@/components/queries/MonacoSqlEditor'
import { ParamRail } from '@/components/queries/ParamRail'
import { ResultsDock, type RunState } from '@/components/queries/ResultsDock'
import { SchemaRail } from '@/components/queries/SchemaRail'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform)
const RUN_KEY = isMac ? '⌘⏎' : 'Ctrl+⏎'
const SAVE_KEY = isMac ? '⌘S' : 'Ctrl+S'

// Parse a raw input string as a typed param value. ok=false → not parseable.
function parseTyped(raw: string, type: ParamType): { ok: true; value: ParamValue } | { ok: false } {
  if (type === 'string') return { ok: true, value: raw }
  const trimmed = raw.trim()
  if (type === 'bool') {
    return trimmed === 'true' || trimmed === 'false' ? { ok: true, value: trimmed === 'true' } : { ok: false }
  }
  if (type === 'int') {
    return /^-?\d+$/.test(trimmed) ? { ok: true, value: Number.parseInt(trimmed, 10) } : { ok: false }
  }
  const n = Number(trimmed)
  return trimmed !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false }
}

// The params a piece of SQL declares: one per :name, carrying whatever type,
// default and description the author has chosen for that name. A default that
// does not parse as its type is reported in `invalid` and left off the param.
function deriveParams(
  sql: string,
  types: Record<string, ParamType>,
  defaults: Record<string, string>,
  descriptions: Record<string, string>
): { params: ToolParam[]; invalidDefaults: Set<string> } {
  const invalidDefaults = new Set<string>()
  const params = placeholderNames(sql).map((name) => {
    const type = types[name] ?? 'string'
    const param: ToolParam = { name, type }
    const raw = defaults[name]
    if (raw !== undefined) {
      const parsed = parseTyped(raw, type)
      if (parsed.ok) param.default = parsed.value
      else invalidDefaults.add(name)
    }
    const text = (descriptions[name] ?? '').trim()
    if (text !== '') param.description = text
    return param
  })
  return { params, invalidDefaults }
}

// Key order and absent keys normalised, so dirty-comparison is stable.
function normalizeParams(params: ToolParam[]): ToolParam[] {
  return params.map((p) => ({
    name: p.name,
    type: p.type,
    ...(p.default !== undefined && p.default !== null ? { default: p.default } : {}),
    ...(p.description ? { description: p.description } : {}),
  }))
}

// The custom-tool workbench: Monaco on the left, a rail on the right showing
// either the tool (params, groups) or the database's schema, results docked below. Create (/tools/new) and edit (/tools/:name) share it;
// Run executes the DRAFT, so nothing needs saving to iterate.
export function ToolEditorPage() {
  const { name: routeName } = useParams()
  const isNew = routeName === undefined
  const navigate = useNavigate()
  const location = useLocation()
  // The SQL console's "Save as tool" hands its statement over through router state.
  const seedSql = (location.state as { sql?: string } | null)?.sql ?? ''

  const customTools = useCustomToolsStore((s) => s.tools)
  const fetchTools = useCustomToolsStore((s) => s.fetchTools)
  const fetchTool = useCustomToolsStore((s) => s.fetchTool)
  const createTool = useCustomToolsStore((s) => s.createTool)
  const updateTool = useCustomToolsStore((s) => s.updateTool)
  const testDraft = useCustomToolsStore((s) => s.testDraft)
  const tools = useCatalogStore((s) => s.tools)
  const groups = useCatalogStore((s) => s.groups)
  const fetchCatalog = useCatalogStore((s) => s.fetchCatalog)
  const schema = useCatalogStore((s) => s.schema)
  const schemaLoaded = useCatalogStore((s) => s.schemaLoaded)
  const schemaError = useCatalogStore((s) => s.schemaError)
  const fetchSchema = useCatalogStore((s) => s.fetchSchema)

  // The loaded tool (edit mode) — also the dirty-check baseline.
  const [loaded, setLoaded] = useState<CustomTool | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'missing'>(isNew ? 'ready' : 'loading')

  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sql, setSqlState] = useState(seedSql)
  // Run and Save can be triggered from the keyboard before React has rendered
  // the last keystroke; they read the editor's current text from this ref.
  const sqlRef = useRef(seedSql)
  const setSql = (next: string) => {
    sqlRef.current = next
    setSqlState(next)
  }
  const [allowWrites, setAllowWrites] = useState(false)
  // Custom groups this tool is in. (It is always in "Custom tools" and "Everything".)
  const [toolGroups, setToolGroups] = useState<string[]>([])
  // Chosen types/defaults/descriptions survive a placeholder being temporarily deleted from the SQL.
  const [paramTypes, setParamTypes] = useState<Record<string, ParamType>>({})
  // Raw default inputs (no entry = no default → the param is required).
  const [paramDefaults, setParamDefaults] = useState<Record<string, string>>({})
  const [paramDescriptions, setParamDescriptions] = useState<Record<string, string>>({})
  const [testValues, setTestValues] = useState<Record<string, string>>({})
  const [invalidValues, setInvalidValues] = useState<Set<string>>(new Set())
  const [flashParam, setFlashParam] = useState<string | null>(null)
  const [runState, setRunState] = useState<RunState>({ phase: 'idle' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [savedFlash, setSavedFlash] = useState<string | null>(null)
  const [rail, setRail] = useState<'tool' | 'schema'>('tool')
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    void fetchTools() // the live name-uniqueness check needs the list
    void fetchCatalog() // …and the built-in tool names it must not shadow, and the groups
    void fetchSchema()
  }, [fetchTools, fetchCatalog, fetchSchema])

  useEffect(() => {
    setSchemaCompletions(schema)
  }, [schema])

  useEffect(() => {
    if (isNew) return
    let active = true
    void fetchTool(routeName).then((q) => {
      if (!active) return
      if (!q) {
        setLoadState('missing')
        return
      }
      setLoaded({ ...q, params: normalizeParams(q.params) })
      setName(q.name)
      setDescription(q.description)
      setSql(q.sql)
      setAllowWrites(q.allow_writes)
      setToolGroups(q.groups)
      setParamTypes(Object.fromEntries(q.params.map((p) => [p.name, p.type])))
      setParamDefaults(
        Object.fromEntries(q.params.filter((p) => p.default !== undefined).map((p) => [p.name, String(p.default)]))
      )
      setParamDescriptions(
        Object.fromEntries(q.params.filter((p) => p.description).map((p) => [p.name, p.description ?? '']))
      )
      setLoadState('ready')
    })
    return () => {
      active = false
    }
  }, [isNew, routeName, fetchTool])

  // ── the params, derived live from the SQL ────────────────────────────────────
  // A param is REQUIRED unless its name has an entry in paramDefaults. The
  // entry's text becomes the typed default — one that doesn't parse as the
  // declared type lands in invalidDefaults and blocks run/save until fixed.
  const { params, invalidDefaults } = useMemo(
    () => deriveParams(sql, paramTypes, paramDefaults, paramDescriptions),
    [sql, paramTypes, paramDefaults, paramDescriptions]
  )

  // ── validation ───────────────────────────────────────────────────────────────
  const trimmedName = name.trim()
  const nameFormatOk = TOOL_NAME_RE.test(trimmedName)
  const nameTaken = isNew && nameFormatOk && customTools.some((q) => q.name === trimmedName)
  const nameReserved =
    isNew &&
    nameFormatOk &&
    (trimmedName === 'sql' || tools.some((t) => t.kind === 'builtin' && t.name === trimmedName))
  const nameError =
    isNew && trimmedName !== '' && !nameFormatOk
      ? 'Start with a letter; lowercase letters, digits and underscores only. This is the tool name MCP clients call.'
      : nameTaken
        ? `A custom tool named “${trimmedName}” already exists.`
        : nameReserved
          ? `“${trimmedName}” is the name of a built-in tool.`
          : null
  const sqlError = hasMultipleStatements(sql) ? 'A custom tool is a single SQL statement.' : null

  const templateOk = sql.trim() !== '' && sqlError === null && invalidDefaults.size === 0
  const canRun = templateOk && runState.phase !== 'running'
  const dirty =
    loaded === null
      ? sql.trim() !== '' || trimmedName !== '' || description.trim() !== ''
      : sql !== loaded.sql ||
        description !== loaded.description ||
        allowWrites !== loaded.allow_writes ||
        JSON.stringify(params) !== JSON.stringify(loaded.params) ||
        [...toolGroups].sort().join() !== [...loaded.groups].sort().join()
  const canSave = templateOk && !saving && (isNew ? nameFormatOk && !nameTaken && !nameReserved : dirty)

  // Warn before the tab closes on unsaved work (the editor holds real SQL).
  useEffect(() => {
    if (!dirty || loadState !== 'ready') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, loadState])

  async function onRun() {
    // Work from the editor's current text, not the last render's.
    const text = sqlRef.current
    const { params, invalidDefaults } = deriveParams(text, paramTypes, paramDefaults, paramDescriptions)
    if (text.trim() === '' || hasMultipleStatements(text) || invalidDefaults.size > 0 || runState.phase === 'running') {
      return
    }
    // Coerce test values per declared type; flag the ones that don't parse. A
    // param with a default and an empty test value is OMITTED — the run then
    // exercises the same default-binding path a real caller hits.
    const coerced: Record<string, unknown> = {}
    const bad = new Set<string>()
    for (const p of params) {
      const raw = testValues[p.name] ?? ''
      if (raw.trim() === '' && p.default !== undefined) continue
      if (p.type === 'bool') {
        coerced[p.name] = (raw.trim() === '' ? 'true' : raw.trim()) === 'true'
        continue
      }
      const parsed = parseTyped(raw, p.type)
      if (parsed.ok) coerced[p.name] = parsed.value
      else bad.add(p.name)
    }
    setInvalidValues(bad)
    if (bad.size > 0) {
      setRunState({
        phase: 'error',
        message: `Give ${[...bad].map((n) => `:${n}`).join(', ')} a test value matching ${bad.size === 1 ? 'its' : 'their'} declared type first.`,
      })
      return
    }
    setRunState({ phase: 'running' })
    const outcome = await testDraft({
      ...(nameFormatOk ? { name: trimmedName } : {}),
      sql: text,
      params,
      values: coerced,
      allow_writes: allowWrites,
    })
    if ('result' in outcome) {
      setRunState({ phase: 'ok', result: outcome.result, writesEnabled: allowWrites })
    } else {
      const { error } = outcome
      setRunState({
        phase: 'error',
        message: error.message,
        detail: error instanceof ApiError ? error.detail : null,
        hint: error instanceof ApiError ? error.hint : null,
      })
    }
  }

  async function onSave() {
    const text = sqlRef.current
    const { params, invalidDefaults } = deriveParams(text, paramTypes, paramDefaults, paramDescriptions)
    if (text.trim() === '' || hasMultipleStatements(text) || invalidDefaults.size > 0 || saving) return
    if (isNew ? !nameFormatOk || nameTaken || nameReserved : !dirty && text === sql) return
    setSaving(true)
    setSaveError(null)
    const payload = {
      sql: text,
      params,
      description: description.trim(),
      allow_writes: allowWrites,
      groups: toolGroups,
    }
    const saved = isNew ? await createTool({ name: trimmedName, ...payload }) : await updateTool(loaded!.name, payload)
    setSaving(false)
    if ('error' in saved) {
      setSaveError(saved.error)
      return
    }
    setLoaded({ ...saved, params: normalizeParams(saved.params) })
    setDescription(saved.description)
    setToolGroups(saved.groups)
    void fetchCatalog()
    setSavedFlash(`Saved v${saved.version}`)
    window.setTimeout(() => setSavedFlash(null), 2500)
    if (isNew) navigate(`/tools/${saved.name}`, { replace: true })
  }

  function insert(text: string) {
    const editor = editorRef.current
    if (!editor) return
    const selection = editor.getSelection()
    if (selection) editor.executeEdits('schema-rail', [{ range: selection, text, forceMoveMarkers: true }])
    editor.focus()
  }

  // The rail's "Add": write ':name' at the cursor. A placeholder is only read
  // as one when it does not run into a word or another colon, so space it off.
  function addParam(pname: string, type: ParamType): boolean {
    const editor = editorRef.current
    const model = editor?.getModel()
    const selection = editor?.getSelection()
    if (!editor || !model || !selection) return false
    const known = placeholderNames(sqlRef.current).includes(pname)
    const before = model.getValueInRange({
      startLineNumber: selection.startLineNumber,
      startColumn: Math.max(1, selection.startColumn - 1),
      endLineNumber: selection.startLineNumber,
      endColumn: selection.startColumn,
    })
    const after = model.getValueInRange({
      startLineNumber: selection.endLineNumber,
      startColumn: selection.endColumn,
      endLineNumber: selection.endLineNumber,
      endColumn: selection.endColumn + 1,
    })
    const text = `${/[^\s(]/.test(before) ? ' ' : ''}:${pname}${/\w/.test(after) ? ' ' : ''}`
    editor.executeEdits('param-rail', [{ range: selection, text, forceMoveMarkers: true }])
    editor.focus()
    // A name the SQL already uses keeps the type it was given.
    if (!known) setParamTypes((t) => ({ ...t, [pname]: type }))
    return placeholderNames(editor.getValue()).includes(pname)
  }

  // Guard every way out of a dirty editor (breadcrumb link + sidebar nav).
  const dirtyBlocking = dirty && loadState === 'ready'
  const confirmLeave = () => !dirtyBlocking || window.confirm('Discard unsaved changes?')

  const title = isNew ? trimmedName || 'New custom tool' : routeName

  const crumb = (
    <>
      <Link
        to="/tools"
        className="shrink-0 underline-offset-4 hover:text-foreground hover:underline"
        onClick={(e) => {
          if (!confirmLeave()) e.preventDefault()
        }}
      >
        Tools
      </Link>
      <span className="text-muted-foreground/60">/</span>
      <span className="truncate font-mono font-medium text-foreground">{title}</span>
      {loaded ? <span className="shrink-0 text-xs text-muted-foreground">v{loaded.version}</span> : null}
      {dirtyBlocking ? (
        <span
          className="size-1.5 shrink-0 rounded-full bg-[var(--sq-param-ink)]"
          title="Unsaved changes"
          aria-label="Unsaved changes"
        />
      ) : null}
    </>
  )

  const actions =
    loadState === 'ready' ? (
      <>
        {savedFlash ? <span className="text-xs text-muted-foreground">{savedFlash}</span> : null}
        <Switch
          checked={allowWrites}
          onChange={setAllowWrites}
          tone="caution"
          label="Allow writes"
          title={
            allowWrites
              ? 'This tool may modify data — whoever can call it can run this write'
              : 'Runs in a read-only transaction. Enable to let this tool modify data.'
          }
        />
        <Button type="button" variant="outline" disabled={!canRun} onClick={onRun} title={`Run the draft (${RUN_KEY})`}>
          {runState.phase === 'running' ? <Loader2 className="animate-spin" /> : <Play />}
          Run
          <kbd className="ml-0.5 font-sans text-xs text-muted-foreground">{RUN_KEY}</kbd>
        </Button>
        <Button type="button" disabled={!canSave} onClick={onSave} title={`Save (${SAVE_KEY})`}>
          {saving ? <Loader2 className="animate-spin" /> : null}
          {isNew ? 'Create tool' : 'Save'}
        </Button>
      </>
    ) : undefined

  return (
    <AdminShell active="tools" title={crumb} actions={actions} flush confirmLeave={confirmLeave}>
      {loadState === 'loading' ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : loadState === 'missing' ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <p className="text-sm text-muted-foreground">
            No custom tool named <span className="font-mono">{routeName}</span>.
          </p>
          <Button asChild variant="outline" size="sm">
            <Link to="/tools">Back to tools</Link>
          </Button>
        </div>
      ) : (
        <>
          {/* ── meta strip: the tool's identity ─────────────────────────────── */}
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-border px-5 py-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
              {isNew ? (
                <Input
                  aria-label="Tool name"
                  aria-invalid={nameError !== null || undefined}
                  className="w-56 font-mono"
                  placeholder="orders_by_status"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoFocus
                />
              ) : null}
              <Input
                aria-label="Description"
                className="min-w-40 flex-1"
                placeholder="Instructions for agents about what this tool does and when to use it"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            {nameError || sqlError || saveError ? <ErrorNote>{nameError ?? sqlError ?? saveError}</ErrorNote> : null}
          </div>

          {/* ── the sheet + the param rail ──────────────────────────────────── */}
          <div className="flex min-h-72 flex-1 flex-col md:min-h-0 md:flex-row">
            <div className="h-[45dvh] min-h-56 min-w-0 flex-none bg-[var(--sq-sheet)] md:h-auto md:min-h-0 md:flex-1">
              <MonacoSqlEditor
                value={sql}
                onChange={setSql}
                params={params}
                onRun={onRun}
                onSave={onSave}
                flashParam={flashParam}
                autoFocus={!isNew}
                onMount={(editor) => {
                  editorRef.current = editor
                }}
              />
            </div>
            <aside className="flex w-full shrink-0 flex-col border-t border-border md:w-[300px] md:border-l md:border-t-0">
              <div role="tablist" aria-label="Rail" className="flex shrink-0 gap-1 border-b border-border px-2 pt-1.5">
                {(['tool', 'schema'] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    role="tab"
                    id={`rail-tab-${key}`}
                    aria-selected={rail === key}
                    aria-controls={`rail-panel-${key}`}
                    className={cn(
                      '-mb-px rounded-t-md border-b-2 px-2.5 py-1.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50',
                      rail === key
                        ? 'border-primary text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground'
                    )}
                    onClick={() => setRail(key)}
                  >
                    {key === 'tool' ? `Parameters${params.length > 0 ? ` · ${params.length}` : ''}` : 'Schema'}
                  </button>
                ))}
              </div>
              {/* Both stay mounted, so the schema's filter and open tables survive a look at the params. */}
              <div
                role="tabpanel"
                id="rail-panel-schema"
                aria-labelledby="rail-tab-schema"
                className={cn('max-h-64 min-h-0 flex-1 md:max-h-none', rail !== 'schema' && 'hidden')}
              >
                <SchemaRail tables={schema} loaded={schemaLoaded} error={schemaError} onInsert={insert} heading={false} />
              </div>
              <div
                role="tabpanel"
                id="rail-panel-tool"
                aria-labelledby="rail-tab-tool"
                className={cn('min-h-0 flex-1', rail !== 'tool' && 'hidden')}
              >
                <ParamRail
                  params={params}
                  values={testValues}
                  invalidValues={invalidValues}
                  defaults={paramDefaults}
                  invalidDefaults={invalidDefaults}
                  descriptions={paramDescriptions}
                  onTypeChange={(pname, type) => {
                    setParamTypes((t) => ({ ...t, [pname]: type }))
                    // A bool default comes from a select; text left over from another type has no option there.
                    if (type === 'bool') {
                      setParamDefaults((d) =>
                        d[pname] === undefined || d[pname] === 'true' || d[pname] === 'false' ? d : { ...d, [pname]: 'true' }
                      )
                    }
                  }}
                  onRequiredChange={(pname, required) =>
                    setParamDefaults((d) => {
                      const next = { ...d }
                      if (required) delete next[pname]
                      // Bool defaults come from a select — seed a valid value.
                      else next[pname] = (paramTypes[pname] ?? 'string') === 'bool' ? 'true' : ''
                      return next
                    })
                  }
                  onDefaultChange={(pname, value) => setParamDefaults((d) => ({ ...d, [pname]: value }))}
                  onDescriptionChange={(pname, value) => setParamDescriptions((d) => ({ ...d, [pname]: value }))}
                  onValueChange={(pname, value) => {
                    setTestValues((v) => ({ ...v, [pname]: value }))
                    setInvalidValues((prev) => {
                      if (!prev.has(pname)) return prev
                      const next = new Set(prev)
                      next.delete(pname)
                      return next
                    })
                  }}
                  onAddParam={addParam}
                  onFlashParam={setFlashParam}
                  toolName={isNew ? trimmedName : (loaded?.name ?? '')}
                  groups={groups.filter((group) => !group.builtin)}
                  selectedGroups={toolGroups}
                  onGroupsChange={setToolGroups}
                />
              </div>
            </aside>
          </div>

          <ResultsDock
            state={runState}
            runKeyHint={RUN_KEY}
            writesArmed={allowWrites}
            idleNote="the draft runs in a read-only transaction; nothing is saved"
          />
        </>
      )}
    </AdminShell>
  )
}
