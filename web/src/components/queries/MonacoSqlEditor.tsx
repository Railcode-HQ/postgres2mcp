import { useEffect, useRef } from 'react'
import { clearParamCompletions, FONT_MONO, monaco, setParamCompletions, themeName } from '@/lib/monacoSql'
import { findPlaceholders } from '@/lib/sqlTemplate'
import type { ToolParam } from '@/lib/types'

interface MonacoSqlEditorProps {
  value: string
  onChange: (sql: string) => void
  /** Declared params (derived from the SQL) — hovers and ':' completions. Omit for plain SQL. */
  params?: ToolParam[]
  onRun: () => void // ⌘/Ctrl+Enter
  onSave?: () => void // ⌘/Ctrl+S
  /** Param name whose occurrences flash (the rail's hover → editor link). */
  flashParam?: string | null
  autoFocus?: boolean
  /** Handed the live editor so the page can drive it (insert at cursor…). */
  onMount?: (editor: monaco.editor.IStandaloneCodeEditor) => void
}

const NO_PARAMS: ToolParam[] = []

// The SQL sheet: Monaco with the app's themes, param decorations (every :name
// in signal blue) and completions for params, tables and columns.
export function MonacoSqlEditor({
  value,
  onChange,
  params,
  onRun,
  onSave,
  flashParam = null,
  autoFocus = false,
  onMount,
}: MonacoSqlEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const decorationsRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const flashRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null)
  const templated = params !== undefined
  const declared = params ?? NO_PARAMS

  // Callback refs so the one-time editor setup never holds stale closures.
  const onChangeRef = useRef(onChange)
  const onRunRef = useRef(onRun)
  const onSaveRef = useRef(onSave)
  const onMountRef = useRef(onMount)
  const paramsRef = useRef(declared)
  // Values the editor has emitted that React has not rendered back yet.
  const pendingRef = useRef<string[]>([])
  onChangeRef.current = onChange
  onRunRef.current = onRun
  onSaveRef.current = onSave
  onMountRef.current = onMount
  paramsRef.current = declared

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const editor = monaco.editor.create(container, {
      value,
      language: 'sql',
      theme: themeName(document.documentElement.classList.contains('dark')),
      ariaLabel: 'SQL',
      fontFamily: FONT_MONO,
      fontSize: 13,
      lineHeight: 21,
      padding: { top: 14, bottom: 14 },
      tabSize: 2,
      wordWrap: 'on',
      minimap: { enabled: false },
      folding: false,
      glyphMargin: false,
      lineDecorationsWidth: 14,
      lineNumbersMinChars: 3,
      renderLineHighlight: 'none',
      scrollBeyondLastLine: false,
      overviewRulerLanes: 0,
      hideCursorInOverviewRuler: true,
      scrollbar: { useShadows: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      contextmenu: false,
      quickSuggestions: { other: true, comments: false, strings: false },
      wordBasedSuggestions: 'off',
      suggestOnTriggerCharacters: true,
      // Enter is a newline, always; Tab accepts a suggestion.
      acceptSuggestionOnEnter: 'off',
      fixedOverflowWidgets: true,
      automaticLayout: true,
    })
    editorRef.current = editor
    decorationsRef.current = editor.createDecorationsCollection()
    flashRef.current = editor.createDecorationsCollection()

    const model = editor.getModel()
    if (model) setParamCompletions(model, () => paramsRef.current)

    const sub = editor.onDidChangeModelContent(() => {
      const next = editor.getValue()
      pendingRef.current.push(next)
      onChangeRef.current(next)
    })
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current())
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current?.())

    // Follow the app theme (the toggle flips `.dark` on <html>).
    const observer = new MutationObserver(() => {
      monaco.editor.setTheme(themeName(document.documentElement.classList.contains('dark')))
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    if (autoFocus) editor.focus()
    onMountRef.current?.(editor)

    return () => {
      observer.disconnect()
      sub.dispose()
      if (model) clearParamCompletions(model)
      editor.dispose()
      editorRef.current = null
    }
    // Created exactly once — value/params/handlers flow through refs + effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // External value replacement (a fetched query arriving). A value the editor
  // itself emitted is only React catching up — the editor may already be
  // several keystrokes ahead, and writing the stale text back would scramble
  // what is being typed. Only a value that never came from the editor is applied.
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const echoed = pendingRef.current.lastIndexOf(value)
    if (echoed !== -1) {
      pendingRef.current = pendingRef.current.slice(echoed + 1)
      return
    }
    pendingRef.current = []
    if (editor.getValue() !== value) editor.setValue(value)
  }, [value])

  // Every placeholder occurrence gets a wash and a hover saying what it is.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    if (!templated) {
      decorationsRef.current?.clear()
      return
    }
    const byName = new Map(declared.map((p) => [p.name, p]))
    decorationsRef.current?.set(
      findPlaceholders(value).map((hit) => {
        const start = model.getPositionAt(hit.start)
        const end = model.getPositionAt(hit.end)
        const p = byName.get(hit.name)
        const type = p?.type ?? 'string'
        const hover =
          p?.default !== undefined
            ? `**Param** \`${hit.name}\` (${type}, optional) — defaults to \`${JSON.stringify(p.default)}\` when the caller omits it.`
            : `**Param** \`${hit.name}\` (${type}) — supplied by the caller.`
        return {
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
          options: { inlineClassName: 'sq-param', hoverMessage: { value: hover } },
        }
      })
    )
  }, [value, declared, templated])

  // Rail hover → flash that param's occurrences in the sheet.
  useEffect(() => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model) return
    if (!flashParam) {
      flashRef.current?.clear()
      return
    }
    flashRef.current?.set(
      findPlaceholders(value)
        .filter((hit) => hit.name === flashParam)
        .map((hit) => {
          const start = model.getPositionAt(hit.start)
          const end = model.getPositionAt(hit.end)
          return {
            range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
            options: { inlineClassName: 'sq-flash' },
          }
        })
    )
  }, [flashParam, value])

  return <div ref={containerRef} className="h-full min-h-0 w-full" />
}
