// Client-side mirror of the server's lexical placeholder extraction
// (src/sql/sqltext.ts): ':name' placeholders are found in CODE spans only —
// never inside string literals, quoted identifiers, comments, or dollar-quoted
// bodies. The server stays the authority at save time; this exists so the
// editor can highlight params and derive the param rail live.

/** A custom tool's name is the MCP tool name. */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]{0,63}$/
export const GROUP_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/
/** What may follow the ':' of a placeholder (the name PLACEHOLDER_RE captures). */
export const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

type SegmentKind = 'code' | 'string' | 'ident' | 'dollar' | 'lineComment' | 'blockComment'

interface Segment {
  kind: SegmentKind
  start: number
  end: number // exclusive
}

const DOLLAR_OPEN = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y

const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/.test(ch)

function scanQuoted(sql: string, start: number, quote: string): number {
  const n = sql.length
  let j = start + 1
  while (j < n) {
    if (sql[j] === quote) {
      if (sql[j + 1] === quote) {
        j += 2 // doubled-quote escape
        continue
      }
      return j + 1
    }
    j += 1
  }
  return n
}

// Postgres E'…' strings are the one place a backslash escapes a quote.
function scanEscapeString(sql: string, start: number): number {
  const n = sql.length
  let j = start + 1
  while (j < n) {
    if (sql[j] === '\\' && j + 1 < n) {
      j += 2
      continue
    }
    if (sql[j] === "'") {
      if (sql[j + 1] === "'") {
        j += 2
        continue
      }
      return j + 1
    }
    j += 1
  }
  return n
}

/** Split SQL into typed spans so placeholder scanning only touches `code`. */
export function segments(sql: string): Segment[] {
  const n = sql.length
  const segs: Segment[] = []
  let codeStart = 0
  let i = 0

  const flush = (upto: number) => {
    if (upto > codeStart) segs.push({ kind: 'code', start: codeStart, end: upto })
  }

  while (i < n) {
    const ch = sql[i]
    if (ch === '-' && sql[i + 1] === '-') {
      flush(i)
      let j = i + 2
      while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j += 1
      if (j < n) j += 1
      segs.push({ kind: 'lineComment', start: i, end: j })
      i = codeStart = j
    } else if (ch === '/' && sql[i + 1] === '*') {
      flush(i)
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1
          j += 2
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1
          j += 2
        } else {
          j += 1
        }
      }
      segs.push({ kind: 'blockComment', start: i, end: j })
      i = codeStart = j
    } else if (ch === "'") {
      const prefix = sql[i - 1]
      const escape = (prefix === 'E' || prefix === 'e') && !isWordChar(sql[i - 2])
      flush(i)
      const j = escape ? scanEscapeString(sql, i) : scanQuoted(sql, i, "'")
      segs.push({ kind: 'string', start: i, end: j })
      i = codeStart = j
    } else if (ch === '"') {
      flush(i)
      const j = scanQuoted(sql, i, '"')
      segs.push({ kind: 'ident', start: i, end: j })
      i = codeStart = j
    } else if (ch === '$' && sql[i + 1] !== undefined && sql[i + 1]! >= '0' && sql[i + 1]! <= '9') {
      i += 1 // $N placeholder — stays in the code span
    } else if (ch === '$' && !isWordChar(sql[i - 1])) {
      DOLLAR_OPEN.lastIndex = i
      const m = DOLLAR_OPEN.exec(sql)
      if (m) {
        flush(i)
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? n : close + tag.length
        segs.push({ kind: 'dollar', start: i, end })
        i = codeStart = end
      } else {
        i += 1
      }
    } else {
      i += 1
    }
  }
  flush(n)
  return segs
}

// ':name' inside a code span. The lookbehind skips Postgres '::' casts while
// still matching after any real operator/punctuation ('= :name', '(:a').
const PLACEHOLDER_RE = /(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)/g

export interface PlaceholderHit {
  name: string
  start: number // absolute offset of the ':'
  end: number // exclusive
}

/** Every ':name' occurrence in code spans, with absolute offsets (for decorations). */
export function findPlaceholders(sql: string): PlaceholderHit[] {
  const hits: PlaceholderHit[] = []
  for (const seg of segments(sql)) {
    if (seg.kind !== 'code') continue
    const text = sql.slice(seg.start, seg.end)
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      hits.push({ name: m[1]!, start: seg.start + m.index, end: seg.start + m.index + m[0].length })
    }
  }
  return hits
}

/** Unique placeholder names in first-occurrence order (mirrors the server). */
export function placeholderNames(sql: string): string[] {
  const seen: string[] = []
  for (const hit of findPlaceholders(sql)) {
    if (!seen.includes(hit.name)) seen.push(hit.name)
  }
  return seen
}

/** True when the text holds more than one ';'-separated statement. */
export function hasMultipleStatements(sql: string): boolean {
  let separatorSeen = false
  for (const seg of segments(sql)) {
    if (seg.kind === 'lineComment' || seg.kind === 'blockComment') continue
    if (seg.kind !== 'code') {
      if (separatorSeen) return true
      continue
    }
    for (let i = seg.start; i < seg.end; i++) {
      const ch = sql[i]!
      if (ch === ';') separatorSeen = true
      else if (separatorSeen && !/\s/.test(ch)) return true
    }
  }
  return false
}
