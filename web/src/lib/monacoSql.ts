// Monaco, configured for SQL and nothing else.
//
// Bundled from ESM (no CDN — the dashboard must work self-hosted and offline):
// `editor.all` pulls the editor features and the single `sql` contribution
// supplies tokenization, skipping the ~80 other languages `editor.main` would
// drag in. Only ever imported from lazy page chunks, so none of this weighs on
// the main bundle.

import 'monaco-editor/esm/vs/editor/editor.all.js'
import 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'
import type { ToolParam, SchemaTable } from '@/lib/types'

self.MonacoEnvironment = {
  // SQL has no language service — the core editor worker is the only one needed.
  getWorker: () => new EditorWorker(),
}

// Disposing an editor cancels whatever it had in flight (a hover, a suggest
// request), and Monaco lets those cancellations surface as unhandled promise
// rejections. They are not errors; keep them out of the console.
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason as { name?: unknown } | null
  if (reason?.name === 'Canceled') event.preventDefault()
})

export { monaco }

export const FONT_MONO = '"JetBrains Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace'

// ── themes ───────────────────────────────────────────────────────────────────
// Derived from the tokens in index.css (kept in sync by hand — Monaco needs
// concrete hex). The sheet sits a hair below the page surface and everything
// stays quiet so the param decorations are the loudest thing on it.

monaco.editor.defineTheme('p2m-light', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'keyword.sql', foreground: '1e40af' },
    { token: 'operator.sql', foreground: '687385' },
    { token: 'predefined.sql', foreground: '0e7490' },
    { token: 'string.sql', foreground: '2e7d5b' },
    { token: 'number.sql', foreground: 'b45309' },
    { token: 'comment.sql', foreground: '9aa1b2', fontStyle: 'italic' },
    { token: 'comment.quote.sql', foreground: '9aa1b2', fontStyle: 'italic' },
    { token: 'delimiter.sql', foreground: '687385' },
    { token: 'identifier.sql', foreground: '1a1f36' },
  ],
  colors: {
    'editor.background': '#fafbfc',
    'editor.foreground': '#1a1f36',
    'editorLineNumber.foreground': '#b7bdc9',
    'editorLineNumber.activeForeground': '#687385',
    'editorCursor.foreground': '#2563eb',
    'editor.selectionBackground': '#2563eb26',
    'editor.inactiveSelectionBackground': '#2563eb14',
    'editorBracketMatch.background': '#2563eb1a',
    'editorBracketMatch.border': '#2563eb55',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e6e8eb',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.border': '#e6e8eb',
    'editorSuggestWidget.foreground': '#1a1f36',
    'editorSuggestWidget.selectedBackground': '#f0f1f4',
    'editorSuggestWidget.selectedForeground': '#1a1f36',
    'editorSuggestWidget.selectedIconForeground': '#1a1f36',
    'editorSuggestWidget.highlightForeground': '#2563eb',
    'editorSuggestWidget.focusHighlightForeground': '#2563eb',
    'scrollbarSlider.background': '#1a1f3614',
    'scrollbarSlider.hoverBackground': '#1a1f3622',
    'scrollbarSlider.activeBackground': '#1a1f362e',
  },
})

monaco.editor.defineTheme('p2m-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'keyword.sql', foreground: '93b4f8' },
    { token: 'operator.sql', foreground: '9b9ba3' },
    { token: 'predefined.sql', foreground: '7ab8c9' },
    { token: 'string.sql', foreground: '85c0a0' },
    { token: 'number.sql', foreground: 'd0a568' },
    { token: 'comment.sql', foreground: '6b6b75', fontStyle: 'italic' },
    { token: 'comment.quote.sql', foreground: '6b6b75', fontStyle: 'italic' },
    { token: 'delimiter.sql', foreground: '9b9ba3' },
    { token: 'identifier.sql', foreground: 'ededee' },
  ],
  colors: {
    'editor.background': '#141417',
    'editor.foreground': '#e6e6e8',
    'editorLineNumber.foreground': '#46464e',
    'editorLineNumber.activeForeground': '#9b9ba3',
    'editorCursor.foreground': '#60a5fa',
    'editor.selectionBackground': '#60a5fa2e',
    'editor.inactiveSelectionBackground': '#60a5fa1a',
    'editorBracketMatch.background': '#60a5fa1f',
    'editorBracketMatch.border': '#60a5fa55',
    'editorWidget.background': '#1f1f23',
    'editorWidget.border': '#2c2c31',
    'editorSuggestWidget.background': '#1f1f23',
    'editorSuggestWidget.border': '#2c2c31',
    'editorSuggestWidget.foreground': '#ededee',
    'editorSuggestWidget.selectedBackground': '#27272b',
    'editorSuggestWidget.selectedForeground': '#ededee',
    'editorSuggestWidget.selectedIconForeground': '#ededee',
    'editorSuggestWidget.highlightForeground': '#60a5fa',
    'editorSuggestWidget.focusHighlightForeground': '#60a5fa',
    'scrollbarSlider.background': '#ededee14',
    'scrollbarSlider.hoverBackground': '#ededee22',
    'scrollbarSlider.activeBackground': '#ededee2e',
  },
})

export const themeName = (dark: boolean) => (dark ? 'p2m-dark' : 'p2m-light')

// ── completions ──────────────────────────────────────────────────────────────
// One global provider (Monaco registers per language, not per editor). Each
// editor contributes its declared params through a per-model getter; the
// database's tables and columns are shared by all of them.

type ParamsGetter = () => ToolParam[]
const paramGetters = new Map<string, ParamsGetter>()
let schemaTables: SchemaTable[] = []

export function setParamCompletions(model: monaco.editor.ITextModel, getter: ParamsGetter) {
  paramGetters.set(model.uri.toString(), getter)
}

export function clearParamCompletions(model: monaco.editor.ITextModel) {
  paramGetters.delete(model.uri.toString())
}

/** Hand the editor the database's tables so it can complete their names. */
export function setSchemaCompletions(tables: SchemaTable[]) {
  schemaTables = tables
}

const needsQuoting = (name: string) => !/^[a-z_][a-z0-9_]*$/.test(name)
const ident = (name: string) => (needsQuoting(name) ? `"${name.replaceAll('"', '""')}"` : name)

monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: [':', '.'],
  provideCompletionItems(model, position) {
    const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1)

    // ':<partial>' — a param (but not after a '::' cast).
    const param = /(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)?$/.exec(before)
    if (param) {
      const range = new monaco.Range(
        position.lineNumber,
        position.column - (param[1]?.length ?? 0),
        position.lineNumber,
        position.column
      )
      const params = paramGetters.get(model.uri.toString())?.() ?? []
      return {
        suggestions: params.map((p, i) => ({
          label: { label: `:${p.name}`, description: p.type },
          kind: monaco.languages.CompletionItemKind.Variable,
          insertText: p.name,
          detail:
            p.default !== undefined ? `${p.type} param · default ${JSON.stringify(p.default)}` : `${p.type} param`,
          sortText: `0${String(i).padStart(3, '0')}`,
          range,
        })),
      }
    }

    const word = model.getWordUntilPosition(position)
    const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)

    // '<table>.<partial>' — that table's columns.
    const dotted = /([A-Za-z_][A-Za-z0-9_]*)\.[A-Za-z0-9_]*$/.exec(before)
    if (dotted) {
      const owner = dotted[1].toLowerCase()
      const tables = schemaTables.filter((t) => t.name.toLowerCase() === owner)
      const inSchema = schemaTables.filter((t) => t.schema.toLowerCase() === owner)
      return {
        suggestions: [
          ...tables.flatMap((t) =>
            t.columns.map((c) => ({
              label: { label: c.name, description: c.type },
              kind: monaco.languages.CompletionItemKind.Field,
              insertText: ident(c.name),
              range,
            }))
          ),
          ...inSchema.map((t) => ({
            label: { label: t.name, description: t.type },
            kind: monaco.languages.CompletionItemKind.Struct,
            insertText: ident(t.name),
            range,
          })),
        ],
      }
    }

    // Anywhere else: tables first, then every column name once.
    const columns = new Map<string, string>()
    for (const t of schemaTables) {
      for (const c of t.columns) if (!columns.has(c.name)) columns.set(c.name, `${t.name} · ${c.type}`)
    }
    return {
      suggestions: [
        ...schemaTables.map((t) => ({
          label: { label: t.name, description: t.schema === 'public' ? t.type : `${t.schema} · ${t.type}` },
          kind: monaco.languages.CompletionItemKind.Struct,
          insertText: t.schema === 'public' ? ident(t.name) : `${ident(t.schema)}.${ident(t.name)}`,
          sortText: `1${t.name}`,
          range,
        })),
        ...[...columns].map(([name, description]) => ({
          label: { label: name, description },
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: ident(name),
          sortText: `2${name}`,
          range,
        })),
      ],
    }
  },
})
