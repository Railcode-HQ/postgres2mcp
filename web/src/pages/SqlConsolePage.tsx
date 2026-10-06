import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BookmarkPlus, Loader2, Play } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { type monaco, setSchemaCompletions } from '@/lib/monacoSql'
import { hasMultipleStatements } from '@/lib/sqlTemplate'
import { useCatalogStore } from '@/stores/catalogStore'
import { useCustomToolsStore } from '@/stores/customToolsStore'
import { AdminShell } from '@/components/layout/AdminShell'
import { MonacoSqlEditor } from '@/components/queries/MonacoSqlEditor'
import { ResultsDock, type RunState } from '@/components/queries/ResultsDock'
import { SchemaRail } from '@/components/queries/SchemaRail'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

const isMac = /Mac|iP(hone|ad|od)/.test(navigator.platform)
const RUN_KEY = isMac ? '⌘⏎' : 'Ctrl+⏎'
const DRAFT_KEY = 'p2m-console-sql'

const readDraft = () => {
  try {
    return sessionStorage.getItem(DRAFT_KEY) ?? ''
  } catch {
    return ''
  }
}

// Arbitrary SQL against the database, as an admin. Read-only until "Allow
// writes" is switched on — which re-arms on every visit, never silently.
export function SqlConsolePage() {
  const navigate = useNavigate()
  const runSql = useCustomToolsStore((s) => s.runSql)
  const schema = useCatalogStore((s) => s.schema)
  const schemaLoaded = useCatalogStore((s) => s.schemaLoaded)
  const schemaError = useCatalogStore((s) => s.schemaError)
  const fetchSchema = useCatalogStore((s) => s.fetchSchema)

  const [sql, setSqlState] = useState(readDraft)
  // The run shortcut can fire before React has rendered the last keystroke, so
  // what gets executed is read from this ref — always the editor's current text.
  const sqlRef = useRef(sql)
  const setSql = (next: string) => {
    sqlRef.current = next
    setSqlState(next)
  }
  const [allowWrites, setAllowWrites] = useState(false)
  const [runState, setRunState] = useState<RunState>({ phase: 'idle' })
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)

  useEffect(() => {
    void fetchSchema()
  }, [fetchSchema])

  useEffect(() => {
    setSchemaCompletions(schema)
  }, [schema])

  // The statement survives a trip to another page, but not the tab closing.
  useEffect(() => {
    try {
      sessionStorage.setItem(DRAFT_KEY, sql)
    } catch {
      /* nothing to do */
    }
  }, [sql])

  const batch = hasMultipleStatements(sql)
  const canRun = sql.trim() !== '' && runState.phase !== 'running'

  async function onRun() {
    const sql = sqlRef.current
    if (sql.trim() === '' || runState.phase === 'running') return
    if (hasMultipleStatements(sql)) {
      setRunState({ phase: 'error', message: 'The console runs one statement at a time. Remove the others, or run them one by one.' })
      return
    }
    setRunState({ phase: 'running' })
    const armed = allowWrites
    const outcome = await runSql({ sql, allow_writes: armed })
    if ('result' in outcome) {
      setRunState({ phase: 'ok', result: outcome.result, writesEnabled: armed })
      // DDL may have changed what there is to complete against.
      if (armed) void fetchSchema()
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

  function insert(text: string) {
    const editor = editorRef.current
    if (!editor) return
    const selection = editor.getSelection()
    if (selection) editor.executeEdits('schema-rail', [{ range: selection, text, forceMoveMarkers: true }])
    editor.focus()
  }

  const actions = (
    <>
      <Switch
        checked={allowWrites}
        onChange={setAllowWrites}
        tone="caution"
        label="Allow writes"
        title={
          allowWrites
            ? 'Statements can change data and schema, and are committed'
            : 'Statements run in a read-only transaction. Enable to let them change data.'
        }
      />
      <Button
        type="button"
        variant="ghost"
        disabled={sql.trim() === '' || batch}
        onClick={() => navigate('/tools/new', { state: { sql } })}
        title="Turn this statement into a custom tool MCP clients can call"
      >
        <BookmarkPlus />
        Save as tool
      </Button>
      <Button type="button" disabled={!canRun} onClick={onRun} title={`Run (${RUN_KEY})`}>
        {runState.phase === 'running' ? <Loader2 className="animate-spin" /> : <Play />}
        {allowWrites ? 'Run with writes' : 'Run'}
        <kbd className="ml-0.5 font-sans text-xs opacity-80">{RUN_KEY}</kbd>
      </Button>
    </>
  )

  return (
    <AdminShell active="sql" actions={actions} flush>
      <div className="flex min-h-72 flex-1 flex-col md:min-h-0 md:flex-row">
        <div className="h-[45dvh] min-h-56 min-w-0 flex-none bg-[var(--sq-sheet)] md:h-auto md:min-h-0 md:flex-1">
          <MonacoSqlEditor
            value={sql}
            onChange={setSql}
            onRun={onRun}
            autoFocus
            onMount={(editor) => {
              editorRef.current = editor
            }}
          />
        </div>
        <aside className="max-h-64 w-full shrink-0 border-t border-border md:max-h-none md:w-[280px] md:border-l md:border-t-0">
          <SchemaRail tables={schema} loaded={schemaLoaded} error={schemaError} onInsert={insert} />
        </aside>
      </div>
      <ResultsDock state={runState} runKeyHint={RUN_KEY} writesArmed={allowWrites} />
    </AdminShell>
  )
}
