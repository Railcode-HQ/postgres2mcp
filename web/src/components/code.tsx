import type { ReactNode } from 'react'
import { CodeBlock } from '@/components/parts'
import { segments } from '@/lib/sqlTemplate'
import { cn } from '@/lib/utils'

// Read-only syntax highlighting for the places code is shown rather than
// edited: SQL in the log, JSON payloads and results, shell snippets. Small
// hand-written tokenizers — the editor's Monaco is far too heavy to pull into
// a log row — coloured to match the editor's theme.

const TOKEN = {
  keyword: 'font-medium text-blue-800 dark:text-blue-300',
  string: 'text-emerald-700 dark:text-emerald-300',
  number: 'text-amber-700 dark:text-amber-300',
  literal: 'text-violet-700 dark:text-violet-300',
  comment: 'italic text-muted-foreground',
  key: 'text-blue-800 dark:text-blue-300',
  punctuation: 'text-muted-foreground',
  param: 'rounded-[3px] bg-[var(--sq-param-bg)] text-[var(--sq-param-ink)]',
  flag: 'text-blue-800 dark:text-blue-300',
} as const

type TokenKind = keyof typeof TOKEN

const span = (kind: TokenKind, text: string, key: number) => (
  <span key={key} className={TOKEN[kind]}>
    {text}
  </span>
)

// ── SQL ──────────────────────────────────────────────────────────────────────

const SQL_KEYWORDS = new Set(
  `add all alter analyze and any as asc begin between by cascade case cast check column commit conflict constraint
  create cross current_date current_timestamp database default delete desc distinct do drop else end except exists
  explain false fetch filter for foreign from full grant group having if ilike in index inner insert intersect into is
  join key lateral left like limit materialized natural not null nulls offset on only or order outer over partition
  primary references returning revoke right rollback row rows schema select set similar table then to transaction
  true truncate union unique update using vacuum values view when where window with`.split(/\s+/)
)

// Within a code span: placeholders, numbers, words, and everything else.
const SQL_CODE = /(\$\d+|(?<![:\w]):[A-Za-z_]\w*)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)|(\s+)|(.)/gs

/** SQL as highlighted nodes. Strings, comments and quoted identifiers are found by the same lexer the editor uses. */
export function highlightSql(sql: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let key = 0
  for (const seg of segments(sql)) {
    const text = sql.slice(seg.start, seg.end)
    if (seg.kind === 'string' || seg.kind === 'dollar') nodes.push(span('string', text, key++))
    else if (seg.kind === 'lineComment' || seg.kind === 'blockComment') nodes.push(span('comment', text, key++))
    else if (seg.kind === 'ident') nodes.push(text)
    else {
      for (const m of text.matchAll(SQL_CODE)) {
        if (m[1]) nodes.push(span('param', m[1], key++))
        else if (m[2]) nodes.push(span('number', m[2], key++))
        else if (m[3]) nodes.push(SQL_KEYWORDS.has(m[3].toLowerCase()) ? span('keyword', m[3], key++) : m[3])
        else if (m[4]) nodes.push(m[4])
        else nodes.push(span('punctuation', m[5], key++))
      }
    }
  }
  return nodes
}

export function SqlCode({ sql, className }: { sql: string; className?: string }) {
  return <CodeBlock className={className}>{highlightSql(sql)}</CodeBlock>
}

/** One line of SQL for a table cell: whitespace collapsed, highlighted, truncated by the cell. */
export function SqlInline({ sql, className }: { sql: string; className?: string }) {
  return <span className={cn('font-mono', className)}>{highlightSql(sql.replace(/\s+/g, ' ').trim())}</span>
}

// ── JSON ─────────────────────────────────────────────────────────────────────

const JSON_TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(true|false|null)|(\s+)|(.)/gs

/** Pretty-printed JSON as highlighted nodes. */
export function highlightJson(json: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let key = 0
  for (const m of json.matchAll(JSON_TOKEN)) {
    if (m[1]) {
      // A string followed by ":" is an object key.
      nodes.push(span(m[2] ? 'key' : 'string', m[1], key++))
      if (m[2]) nodes.push(span('punctuation', m[2], key++))
    } else if (m[3]) nodes.push(span('number', m[3], key++))
    else if (m[4]) nodes.push(span('literal', m[4], key++))
    else if (m[5]) nodes.push(m[5])
    else nodes.push(span('punctuation', m[6], key++))
  }
  return nodes
}

/**
 * A JSON value, or JSON text, pretty-printed and highlighted. Text that does
 * not parse (a truncated log payload) is shown as it is.
 */
export function JsonCode({ value, className }: { value: unknown; className?: string }) {
  let pretty: string | null = null
  if (typeof value === 'string') {
    try {
      pretty = JSON.stringify(JSON.parse(value), null, 2)
    } catch {
      return <CodeBlock className={className}>{value}</CodeBlock>
    }
  } else {
    pretty = JSON.stringify(value, null, 2)
  }
  return <CodeBlock className={className}>{highlightJson(pretty ?? 'null')}</CodeBlock>
}

// ── shell ────────────────────────────────────────────────────────────────────

const SHELL_TOKEN = /("(?:[^"\\]|\\.)*"|'[^']*')|(\s--?[A-Za-z][\w-]*)|(\\\n)|([^\s"'\\]+|\s+|.)/gs

/** A shell command: the program name, flags and quoted strings picked out. */
export function highlightShell(command: string): ReactNode[] {
  const nodes: ReactNode[] = []
  let key = 0
  let first = true
  for (const m of command.matchAll(SHELL_TOKEN)) {
    if (m[1]) nodes.push(span('string', m[1], key++))
    else if (m[2]) nodes.push(span('flag', m[2], key++))
    else if (m[3]) nodes.push(span('punctuation', m[3], key++))
    else if (first && m[4].trim() !== '') {
      nodes.push(span('keyword', m[4], key++))
      first = false
    } else nodes.push(m[4])
  }
  return nodes
}
