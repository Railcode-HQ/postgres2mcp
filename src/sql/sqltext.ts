// Lexical helpers for Postgres SQL text. Placeholder rewriting and the
// single-statement check only ever touch real code spans — never string
// literals, quoted identifiers, comments, or dollar-quoted bodies.
//
// The dashboard carries a mirror of `segments` + `findPlaceholders`
// (web/src/lib/sqlTemplate.ts) so the editor can derive params live; this
// module is the authority at save and invoke time.

export type SegmentKind = "code" | "string" | "ident" | "dollar" | "lineComment" | "blockComment"

export interface Segment {
  readonly kind: SegmentKind
  readonly start: number
  readonly end: number // exclusive
}

const DOLLAR_OPEN = /\$([A-Za-z_][A-Za-z0-9_]*)?\$/y

/** Index just past a quoted span starting at `start` (on the opening quote). */
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

/** Postgres `E'…'` strings are the one place a backslash escapes a quote. */
function scanEscapeString(sql: string, start: number): number {
  const n = sql.length
  let j = start + 1
  while (j < n) {
    if (sql[j] === "\\" && j + 1 < n) {
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

const isWordChar = (ch: string | undefined) => ch !== undefined && /[A-Za-z0-9_]/.test(ch)

/** Split SQL into typed spans so scanning only touches `code`. */
export function segments(sql: string): Array<Segment> {
  const n = sql.length
  const segs: Array<Segment> = []
  let codeStart = 0
  let i = 0

  const flush = (upto: number) => {
    if (upto > codeStart) segs.push({ kind: "code", start: codeStart, end: upto })
  }

  while (i < n) {
    const ch = sql[i]
    if (ch === "-" && sql[i + 1] === "-") {
      flush(i)
      let j = i + 2
      while (j < n && sql[j] !== "\n" && sql[j] !== "\r") j += 1
      if (j < n) j += 1
      segs.push({ kind: "lineComment", start: i, end: j })
      i = codeStart = j
    } else if (ch === "/" && sql[i + 1] === "*") {
      flush(i)
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth += 1
          j += 2
        } else if (sql[j] === "*" && sql[j + 1] === "/") {
          depth -= 1
          j += 2
        } else {
          j += 1
        }
      }
      segs.push({ kind: "blockComment", start: i, end: j })
      i = codeStart = j
    } else if (ch === "'") {
      // E'…' / e'…' — the prefix letter stays in the code span.
      const prefix = sql[i - 1]
      const escape = (prefix === "E" || prefix === "e") && !isWordChar(sql[i - 2])
      flush(i)
      const j = escape ? scanEscapeString(sql, i) : scanQuoted(sql, i, "'")
      segs.push({ kind: "string", start: i, end: j })
      i = codeStart = j
    } else if (ch === "\"") {
      flush(i)
      const j = scanQuoted(sql, i, "\"")
      segs.push({ kind: "ident", start: i, end: j })
      i = codeStart = j
    } else if (ch === "$" && sql[i + 1] !== undefined && sql[i + 1]! >= "0" && sql[i + 1]! <= "9") {
      i += 1 // $N placeholder — stays in the code span
    } else if (ch === "$" && !isWordChar(sql[i - 1])) {
      DOLLAR_OPEN.lastIndex = i
      const m = DOLLAR_OPEN.exec(sql)
      if (m) {
        flush(i)
        const tag = m[0]
        const close = sql.indexOf(tag, i + tag.length)
        const end = close === -1 ? n : close + tag.length
        segs.push({ kind: "dollar", start: i, end })
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

/** True when the text holds more than one `;`-separated statement. */
export function hasMultipleStatements(sql: string): boolean {
  let separatorSeen = false
  for (const seg of segments(sql)) {
    if (seg.kind === "lineComment" || seg.kind === "blockComment") continue
    if (seg.kind !== "code") {
      if (separatorSeen) return true
      continue
    }
    for (let i = seg.start; i < seg.end; i++) {
      const ch = sql[i]!
      if (ch === ";") separatorSeen = true
      else if (separatorSeen && !/\s/.test(ch)) return true
    }
  }
  return false
}

/** True when the text has no statement at all (empty, whitespace, or comments only). */
export function isBlank(sql: string): boolean {
  for (const seg of segments(sql)) {
    if (seg.kind === "lineComment" || seg.kind === "blockComment") continue
    if (seg.kind !== "code") return false
    if (/[^\s;]/.test(sql.slice(seg.start, seg.end))) return false
  }
  return true
}

// `:name` inside a code span. The lookbehind skips Postgres `::` casts while
// still matching after any real operator or punctuation (`= :name`, `(:a`).
const PLACEHOLDER_RE = /(?<![:\w]):([A-Za-z_][A-Za-z0-9_]*)/g

export interface PlaceholderHit {
  readonly name: string
  readonly start: number // absolute offset of the ':'
  readonly end: number // exclusive
}

/** Every `:name` occurrence in code spans, with absolute offsets. */
export function findPlaceholders(sql: string): Array<PlaceholderHit> {
  const hits: Array<PlaceholderHit> = []
  for (const seg of segments(sql)) {
    if (seg.kind !== "code") continue
    const text = sql.slice(seg.start, seg.end)
    for (const m of text.matchAll(PLACEHOLDER_RE)) {
      hits.push({ name: m[1]!, start: seg.start + m.index, end: seg.start + m.index + m[0].length })
    }
  }
  return hits
}

/** Unique placeholder names in first-occurrence order. */
export function placeholderNames(sql: string): Array<string> {
  const seen: Array<string> = []
  for (const hit of findPlaceholders(sql)) {
    if (!seen.includes(hit.name)) seen.push(hit.name)
  }
  return seen
}

/** Rewrite `:name` placeholders to positional `$N`, returning the bind order. */
export function toPositional(sql: string): { readonly sql: string; readonly names: Array<string> } {
  const names: Array<string> = []
  let out = ""
  let cursor = 0
  for (const hit of findPlaceholders(sql)) {
    let index = names.indexOf(hit.name)
    if (index === -1) {
      names.push(hit.name)
      index = names.length - 1
    }
    out += sql.slice(cursor, hit.start) + `$${index + 1}`
    cursor = hit.end
  }
  return { sql: out + sql.slice(cursor), names }
}

/** Quote an identifier for safe interpolation into SQL text. */
export const quoteIdent = (name: string): string => `"${name.replaceAll("\"", "\"\"")}"`

/** `schema.table`, each part quoted. */
export const qualified = (schema: string, table: string): string => `${quoteIdent(schema)}.${quoteIdent(table)}`
